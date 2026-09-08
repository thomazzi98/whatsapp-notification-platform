import {
  DatabaseModule,
  ObservabilityModule,
  ProcessWebhookService,
  QueueModule,
  RuntimeModule,
  WebhookProcessingModule,
} from '@platform/composition';
import {
  connectToTestDatabase,
  createTestConfiguration,
  type TestDatabaseHandle,
} from '@platform/testing';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

let moduleReference: TestingModule;
let processor: ProcessWebhookService;
let database: TestDatabaseHandle;
let fixtureCounter = 0;

beforeAll(async () => {
  const connectionUrl = inject('databaseUrl');
  database = connectToTestDatabase(connectionUrl);

  moduleReference = await Test.createTestingModule({
    imports: [
      ObservabilityModule.forConfiguration(createTestConfiguration(connectionUrl), {
        serviceName: 'worker-test',
      }),
      DatabaseModule.forConfiguration(createTestConfiguration(connectionUrl), {
        applicationName: 'worker-test',
      }),
      QueueModule.forConfiguration(createTestConfiguration(connectionUrl), { supervise: false }),
      RuntimeModule,
      WebhookProcessingModule,
    ],
  }).compile();

  processor = moduleReference.get(ProcessWebhookService);
}, 180_000);

afterAll(async () => {
  await moduleReference.close();
  await database.close();
});

beforeEach(async () => {
  await database.truncateAllTables();
});

interface Fixture {
  readonly applicationId: string;
  readonly whatsAppSessionId: string;
  readonly providerSessionName: string;
}

async function createFixture(): Promise<Fixture> {
  fixtureCounter += 1;
  const providerSessionName = `webhook-test-${String(fixtureCounter)}`;
  const applicationId = await database.insertApplication();
  const whatsAppSessionId = await database.insertWhatsAppSession(
    applicationId,
    providerSessionName,
  );

  return { applicationId, whatsAppSessionId, providerSessionName };
}

async function createSentNotification(
  fixture: Fixture,
  providerMessageId: string,
): Promise<string> {
  return database.insertNotification({
    applicationId: fixture.applicationId,
    whatsAppSessionId: fixture.whatsAppSessionId,
    status: 'SENT',
    attemptCount: 1,
    providerMessageId,
    sentAt: new Date(),
  });
}

let eventCounter = 0;

async function fileAcknowledgement(
  fixture: Fixture,
  payload: Record<string, unknown>,
): Promise<string> {
  eventCounter += 1;

  return database.insertWebhookDelivery({
    applicationId: fixture.applicationId,
    whatsAppSessionId: fixture.whatsAppSessionId,
    providerEventId: `event-${String(eventCounter)}`,
    eventType: 'message.ack',
    providerSessionName: fixture.providerSessionName,
    payload,
  });
}

describe('applying a delivery acknowledgement', () => {
  it('marks a sent notification delivered once the device has it', async () => {
    const fixture = await createFixture();
    const notificationId = await createSentNotification(fixture, 'message-1');
    const deliveryId = await fileAcknowledgement(fixture, { id: 'message-1', ack: 2 });

    const result = await processor.process(deliveryId);
    const notification = await database.readNotification(notificationId);

    expect(result.outcome).toBe('APPLIED');
    expect(notification?.status).toBe('DELIVERED');
    expect(await database.listEventTypes(notificationId)).toContain('notification.acknowledged');
  });

  it('does not treat a read receipt as a status change, because DELIVERED is terminal', async () => {
    const fixture = await createFixture();
    const notificationId = await createSentNotification(fixture, 'message-2');
    await processor.process(await fileAcknowledgement(fixture, { id: 'message-2', ack: 2 }));

    await processor.process(await fileAcknowledgement(fixture, { id: 'message-2', ack: 3 }));
    const notification = await database.readNotification(notificationId);

    expect(notification?.status).toBe('DELIVERED');
  });

  it('keeps the highest acknowledgement when they arrive out of order', async () => {
    const fixture = await createFixture();
    const notificationId = await createSentNotification(fixture, 'message-3');

    await processor.process(await fileAcknowledgement(fixture, { id: 'message-3', ack: 3 }));
    const late = await processor.process(
      await fileAcknowledgement(fixture, { id: 'message-3', ack: 2 }),
    );

    const notification = await database.readNotification(notificationId);

    // A DEVICE receipt arriving after a READ receipt must not undo the read.
    expect(late.outcome).toBe('IGNORED');
    expect(notification?.status).toBe('DELIVERED');
  });

  it('ignores the same acknowledgement arriving twice', async () => {
    const fixture = await createFixture();
    await createSentNotification(fixture, 'message-4');
    await processor.process(await fileAcknowledgement(fixture, { id: 'message-4', ack: 2 }));

    const repeated = await processor.process(
      await fileAcknowledgement(fixture, { id: 'message-4', ack: 2 }),
    );

    expect(repeated.outcome).toBe('IGNORED');
  });

  it('fails a message WhatsApp reported it could not deliver', async () => {
    const fixture = await createFixture();
    const notificationId = await createSentNotification(fixture, 'message-5');

    await processor.process(await fileAcknowledgement(fixture, { id: 'message-5', ack: -1 }));
    const notification = await database.readNotification(notificationId);

    expect(notification?.status).toBe('FAILED');
    expect(notification?.failureCode).toBe('provider_acknowledgement_error');
    expect(notification?.failureClassification).toBe('PERMANENT');
  });

  it('never resends after a failure acknowledgement', async () => {
    const fixture = await createFixture();
    const notificationId = await createSentNotification(fixture, 'message-6');
    await processor.process(await fileAcknowledgement(fixture, { id: 'message-6', ack: -1 }));

    const notification = await database.readNotification(notificationId);

    // The message reached WhatsApp, so there is nothing safe to retry: a resend
    // could deliver the same notification twice.
    expect(notification?.nextAttemptAt).toBeNull();
    expect(await database.countDispatchJobs(notificationId)).toBe(0);
  });

  it('ignores an acknowledgement for a message this platform did not send', async () => {
    const fixture = await createFixture();
    const deliveryId = await fileAcknowledgement(fixture, {
      id: 'inbound-1',
      ack: 2,
      fromMe: false,
    });

    const result = await processor.process(deliveryId);

    expect(result).toEqual({ outcome: 'IGNORED', detail: 'inbound message' });
  });

  it('retries an acknowledgement that arrived before its send committed', async () => {
    const fixture = await createFixture();
    const deliveryId = await fileAcknowledgement(fixture, { id: 'not-yet-sent', ack: 2 });

    // Throwing hands the job back to the queue, which is what lets a receipt
    // that overtook the send still be applied.
    await expect(processor.process(deliveryId)).rejects.toThrow('does not exist yet');
  });

  it('gives up on an acknowledgement whose message never appears', async () => {
    const fixture = await createFixture();
    const deliveryId = await fileAcknowledgement(fixture, { id: 'never-sent', ack: 2 });
    await database.ageWebhookDelivery(deliveryId, 600);

    const result = await processor.process(deliveryId);

    expect(result.outcome).toBe('UNMATCHED');
  });
});

describe('applying a session status change', () => {
  it('records the paired account on the connection', async () => {
    const fixture = await createFixture();
    const deliveryId = await database.insertWebhookDelivery({
      applicationId: fixture.applicationId,
      whatsAppSessionId: fixture.whatsAppSessionId,
      providerEventId: 'session-event-1',
      eventType: 'session.status',
      providerSessionName: fixture.providerSessionName,
      payload: { name: fixture.providerSessionName, status: 'SCAN_QR_CODE' },
    });

    const result = await processor.process(deliveryId);

    expect(result).toEqual({ outcome: 'APPLIED', detail: 'session SCAN_QR_CODE' });
  });

  it('skips an event type it has no rule for, rather than failing the callback', async () => {
    const fixture = await createFixture();
    const deliveryId = await database.insertWebhookDelivery({
      applicationId: fixture.applicationId,
      whatsAppSessionId: fixture.whatsAppSessionId,
      providerEventId: 'session-event-2',
      eventType: 'message.reaction',
      providerSessionName: fixture.providerSessionName,
      payload: {},
    });

    const result = await processor.process(deliveryId);

    expect(result.outcome).toBe('IGNORED');
  });
});

describe('processing a callback twice', () => {
  it('does nothing the second time', async () => {
    const fixture = await createFixture();
    await createSentNotification(fixture, 'message-7');
    const deliveryId = await fileAcknowledgement(fixture, { id: 'message-7', ack: 2 });

    await processor.process(deliveryId);
    const second = await processor.process(deliveryId);

    // A job redelivered after the handler finished must not write a second
    // entry onto the delivery timeline.
    expect(second).toEqual({ outcome: 'IGNORED', detail: 'already processed' });
  });

  it('records how it was resolved, so nothing has to be re-derived later', async () => {
    const fixture = await createFixture();
    await createSentNotification(fixture, 'message-8');
    const deliveryId = await fileAcknowledgement(fixture, { id: 'message-8', ack: 3 });

    await processor.process(deliveryId);
    const [delivery] = await database.listWebhookDeliveries(fixture.applicationId);

    expect(delivery?.processedAt).not.toBeNull();
    expect(delivery?.outcome).toBe('APPLIED');
    expect(delivery?.outcomeDetail).toBe('READ');
  });
});
