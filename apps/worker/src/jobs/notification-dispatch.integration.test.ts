import { type AddressInfo } from 'node:net';

import {
  DatabaseModule,
  DispatchNotificationService,
  NotificationMaintenanceService,
  NotificationDeliveryModule,
  ObservabilityModule,
  QueueModule,
  RuntimeModule,
  WhatsAppProviderModule,
} from '@platform/composition';
import { type ApplicationConfiguration } from '@platform/configuration';
import {
  connectToTestDatabase,
  createTestConfiguration,
  type NotificationFixture,
  type NotificationRow,
  type TestDatabaseHandle,
} from '@platform/testing';
import { createStubServer } from '@platform/waha-stub';
import { Test, type TestingModule } from '@nestjs/testing';
import { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

/**
 * Recipient suffixes the stub reacts to. They make a provider failure a
 * property of the recipient rather than of global state, so several failure
 * paths can be exercised in one run without tests interfering with each other.
 */
const recipients = {
  healthy: '+5511999990000',
  serverError: '+5511999990500',
  unauthorized: '+5511999990401',
  rateLimited: '+5511999990429',
  invalidRequest: '+5511999990422',
  timeout: '+5511999990408',
  connectionReset: '+5511999990499',
  notOnWhatsApp: '+5511999990404',
} as const;

const apiKey = 'worker-integration-stub-key';

let stub: FastifyInstance;
let stubBaseUrl: string;
let moduleReference: TestingModule;
let dispatcher: DispatchNotificationService;
let maintenance: NotificationMaintenanceService;
let database: TestDatabaseHandle;
let configuration: ApplicationConfiguration;
let sessionCounter = 0;

async function buildContext(overrides: Partial<ApplicationConfiguration> = {}): Promise<void> {
  configuration = createTestConfiguration(inject('databaseUrl'), {
    whatsAppProvider: {
      baseUrl: stubBaseUrl,
      apiKey,
      requestTimeoutMilliseconds: 1500,
      webhookPublicUrl: 'http://api.invalid:3000',
      webhookToleranceSeconds: 300,
    },
    ...overrides,
  });

  moduleReference = await Test.createTestingModule({
    imports: [
      ObservabilityModule.forConfiguration(configuration, { serviceName: 'worker-test' }),
      DatabaseModule.forConfiguration(configuration, { applicationName: 'worker-test' }),
      QueueModule.forConfiguration(configuration, { supervise: false }),
      RuntimeModule,
      WhatsAppProviderModule.forConfiguration(configuration),
      NotificationDeliveryModule,
    ],
  }).compile();

  dispatcher = moduleReference.get(DispatchNotificationService);
  maintenance = moduleReference.get(NotificationMaintenanceService);
}

beforeAll(async () => {
  stub = createStubServer({ apiKey });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  stubBaseUrl = `http://127.0.0.1:${String((stub.server.address() as AddressInfo).port)}`;

  database = connectToTestDatabase(inject('databaseUrl'));
  await buildContext();
}, 180_000);

afterAll(async () => {
  await moduleReference.close();
  await database.close();
  await stub.close();
});

beforeEach(async () => {
  await database.truncateAllTables();
  await fetch(`${stubBaseUrl}/__stub/reset`, { method: 'POST' });
});

interface Fixture {
  readonly applicationId: string;
  readonly whatsAppSessionId: string;
  readonly providerSessionName: string;
}

/**
 * Builds a tenant whose WhatsApp connection exists in both the database and the
 * stub, and is paired. Every dispatch test needs this, and a connection that is
 * present in only one of the two produces a failure that looks like a bug in
 * the dispatcher rather than in the fixture.
 */
async function createConnectedTenant(
  options: {
    readonly unknownOutcomePolicy?: 'RETRY' | 'FAIL_CLOSED';
    readonly sessionStatus?: string;
    readonly pacingSeconds?: number;
  } = {},
): Promise<Fixture> {
  sessionCounter += 1;
  const providerSessionName = `worker-test-${String(sessionCounter)}`;
  const applicationId = await database.insertApplication({
    ...(options.unknownOutcomePolicy !== undefined && {
      unknownOutcomePolicy: options.unknownOutcomePolicy,
    }),
  });
  const whatsAppSessionId = await database.insertWhatsAppSession(
    applicationId,
    providerSessionName,
    {
      status: options.sessionStatus ?? 'WORKING',
      ...(options.pacingSeconds !== undefined && {
        sendPacingMinimumSeconds: options.pacingSeconds,
        sendPacingMaximumSeconds: options.pacingSeconds,
      }),
    },
  );

  await fetch(`${stubBaseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ name: providerSessionName, start: true }),
  });
  await fetch(`${stubBaseUrl}/__stub/sessions/${providerSessionName}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phoneNumber: '5511999990000' }),
  });

  return { applicationId, whatsAppSessionId, providerSessionName };
}

/**
 * Reads a notification and insists it exists. Every assertion below is about a
 * row the test created, so a missing one is a broken fixture, not an optional
 * value each assertion should have to unwrap.
 */
async function readNotification(notificationId: string): Promise<NotificationRow> {
  const notification = await database.readNotification(notificationId);

  if (notification === undefined) {
    throw new Error(`The test notification ${notificationId} disappeared.`);
  }
  return notification;
}

async function dispatch(
  fixture: Fixture,
  notificationId: string,
): Promise<{ readonly outcome: string; readonly detail?: string }> {
  return dispatcher.dispatch({
    applicationId: fixture.applicationId,
    notificationId,
    correlationId: 'correlation-for-test',
  });
}

type NotificationOverrides = Partial<
  Omit<NotificationFixture, 'applicationId' | 'whatsAppSessionId'>
>;

/**
 * Waits until the attempt row exists, which is the dispatcher's last commit
 * before it contacts the provider. Waiting only for the claim would land inside
 * beginAttempt's own fence instead of the window under test.
 */
async function waitUntilSendInFlight(notificationId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const attempts = await database.listSendAttempts(notificationId);
    if (attempts.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('The dispatcher never started a send attempt.');
}

async function queueNotification(
  fixture: Fixture,
  overrides: NotificationOverrides = {},
): Promise<string> {
  return database.insertNotification({
    applicationId: fixture.applicationId,
    whatsAppSessionId: fixture.whatsAppSessionId,
    ...overrides,
  });
}

describe('delivering a notification', () => {
  it('sends it and records the provider message identifier', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.healthy });

    const result = await dispatch(fixture, notificationId);
    const notification = await readNotification(notificationId);

    expect(result.outcome).toBe('sent');
    expect(notification.status).toBe('SENT');
    expect(notification.providerMessageId).toBeTruthy();
    expect(notification.sentAt).not.toBeNull();
  });

  it('commits the attempt ledger with the SENT row, not before it', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.healthy });

    await dispatch(fixture, notificationId);

    // Resolved in its own statement ahead of the transition, a crash in the
    // window between the two left an attempt marked SUCCEEDED on a notification
    // still PROCESSING. The reaper then returned it to the queue and WhatsApp
    // received the message twice -- and because the attempt carried a resolved
    // outcome it was never treated as unknown, so FAIL_CLOSED protected nobody.
    const [attempt] = await database.listSendAttempts(notificationId);
    const notification = await readNotification(notificationId);
    expect(attempt?.outcome).toBe('SUCCEEDED');
    expect(notification.status).toBe('SENT');
  });

  it('does not claim to have sent a notification it no longer owns', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.healthy });

    // The send is held open so the row can be taken away underneath it, which
    // is what the reaper does to any claim it considers abandoned. The provider
    // timeout is raised above the delay for this test alone: a send that times
    // out is a different path, and would prove nothing about ownership.
    await buildContext({
      whatsAppProvider: {
        baseUrl: stubBaseUrl,
        apiKey,
        requestTimeoutMilliseconds: 15_000,
        webhookPublicUrl: 'http://api.invalid:3000',
        webhookToleranceSeconds: 300,
      },
    });
    await fetch(`${stubBaseUrl}/__stub/send-delay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ milliseconds: 3000 }),
    });
    const inFlight = dispatch(fixture, notificationId);

    await waitUntilSendInFlight(notificationId);
    await database.ageClaim(notificationId, configuration.delivery.stuckClaimTimeoutSeconds + 60);
    await maintenance.runOnce();

    const result = await inFlight;
    await buildContext();

    // WhatsApp did receive the message. Reporting it sent would be a lie about
    // who owns the row, and writing the timeline event would be permanent:
    // notification_events is append-only by grant, so a SENT entry on a
    // notification that was never moved to SENT could not be corrected.
    expect(result.outcome).toBe('not_claimable');
    const events = await database.listEventTypes(notificationId);
    expect(events).not.toContain('notification.sent');
  });

  it('adds nothing to the ledger when the same job is delivered again', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.healthy });
    await dispatch(fixture, notificationId);

    // pg-boss guarantees at-least-once, so this happens in production whenever
    // a job is redelivered after its handler committed.
    const second = await dispatch(fixture, notificationId);

    expect(second.outcome).toBe('not_claimable');
    expect(await database.listSendAttempts(notificationId)).toHaveLength(1);
    const events = await database.listEventTypes(notificationId);
    expect(events.filter((event) => event === 'notification.sent')).toHaveLength(1);
  });

  it('reports SENT rather than DELIVERED, because nobody has received it yet', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.healthy });

    await dispatch(fixture, notificationId);

    // Delivery is only known once an acknowledgement webhook arrives. Marking
    // it delivered here would be a claim the platform cannot support.
    const notification = await readNotification(notificationId);

    expect(notification.status).toBe('SENT');
  });

  it('releases the claim once it is finished', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.healthy });

    await dispatch(fixture, notificationId);

    const notification = await readNotification(notificationId);

    expect(notification.claimToken).toBeNull();
  });

  it('caches the chat identifier the provider resolved', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.healthy });

    await dispatch(fixture, notificationId);
    const notification = await readNotification(notificationId);

    // Built from the provider's answer, never assembled locally: national
    // numbering rules make a constructed identifier unreliable.
    expect(notification.recipientChatIdentifier).toContain('@c.us');
  });

  it('writes a resolved send attempt for the delivery', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.healthy });

    await dispatch(fixture, notificationId);
    const attempts = await database.listSendAttempts(notificationId);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('SUCCEEDED');
    expect(attempts[0]?.providerMessageId).toBeTruthy();
  });

  it('records the send on the timeline', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.healthy });

    await dispatch(fixture, notificationId);

    expect(await database.listEventTypes(notificationId)).toContain('notification.sent');
  });

  it('consumes exactly one attempt', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.healthy });

    await dispatch(fixture, notificationId);

    const notification = await readNotification(notificationId);

    expect(notification.attemptCount).toBe(1);
  });
});

describe('provider failures', () => {
  it('retries a server error and schedules the next attempt', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.serverError });

    const result = await dispatch(fixture, notificationId);
    const notification = await readNotification(notificationId);

    expect(result.outcome).toBe('retry_scheduled');
    expect(notification.status).toBe('RETRYING');
    expect(notification.failureCode).toBe('provider_server_error');
    expect(notification.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it('fails a rejected payload permanently rather than retrying it forever', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, {
      recipient: recipients.invalidRequest,
    });

    const result = await dispatch(fixture, notificationId);
    const notification = await readNotification(notificationId);

    expect(result.outcome).toBe('failed');
    expect(notification.failureCode).toBe('provider_invalid_request');
    expect(notification.failureClassification).toBe('PERMANENT');
  });

  it('treats a wrong provider credential as an operator problem, not a message problem', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.unauthorized });

    await dispatch(fixture, notificationId);

    // Retrying would hide a misconfiguration that will fail every send until a
    // human fixes it.
    const notification = await readNotification(notificationId);

    expect(notification.failureCode).toBe('provider_unauthorized');
  });

  it('honours the provider Retry-After when it is rate limited', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.rateLimited });

    const before = Date.now();
    await dispatch(fixture, notificationId);
    const notification = await readNotification(notificationId);

    expect(notification.failureCode).toBe('provider_rate_limited');
    // The stub names ninety seconds, and the first retry's own backoff never
    // exceeds sixty. Anything inside that window would mean the header was
    // read and then ignored — which is what this assertion used to allow.
    expect(notification.nextAttemptAt?.getTime()).toBeGreaterThanOrEqual(before + 90_000);
    expect(notification.nextAttemptAt?.getTime()).toBeLessThan(before + 120_000);
  });

  it('fails permanently for a number that is not on WhatsApp', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, {
      recipient: recipients.notOnWhatsApp,
    });

    const result = await dispatch(fixture, notificationId);
    const notification = await readNotification(notificationId);

    expect(result.outcome).toBe('failed');
    expect(notification.failureCode).toBe('recipient_not_on_whatsapp');
    // The recipient check happens before an attempt is consumed: nothing was
    // ever sent, so nothing should be charged.
    expect(notification.attemptCount).toBe(0);
  });

  it('fails once the attempt budget is spent', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, {
      recipient: recipients.serverError,
      maximumAttempts: 1,
    });

    const result = await dispatch(fixture, notificationId);
    const notification = await readNotification(notificationId);

    expect(result.outcome).toBe('failed');
    expect(notification.failureCode).toBe('maximum_attempts_exhausted');
  });
});

describe('a send whose outcome cannot be determined', () => {
  it('retries by default, and records the attempt as unknown rather than failed', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.timeout });

    const result = await dispatch(fixture, notificationId);
    const attempts = await database.listSendAttempts(notificationId);

    expect(result.outcome).toBe('retry_scheduled');
    expect(attempts[0]?.outcome).toBe('UNKNOWN');
    const notification = await readNotification(notificationId);

    expect(notification.failureCode).toBe('provider_outcome_unknown');
  });

  it('stops instead of resending when the application is configured to fail closed', async () => {
    const fixture = await createConnectedTenant({ unknownOutcomePolicy: 'FAIL_CLOSED' });
    const notificationId = await queueNotification(fixture, { recipient: recipients.timeout });

    const result = await dispatch(fixture, notificationId);
    const notification = await readNotification(notificationId);

    expect(result.outcome).toBe('failed');
    expect(notification.failureCode).toBe('unknown_outcome_fail_closed');
  });

  it('treats a connection lost mid-request as unknown, not as a clean failure', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, {
      recipient: recipients.connectionReset,
    });

    await dispatch(fixture, notificationId);

    const [attempt] = await database.listSendAttempts(notificationId);

    expect(attempt?.outcome).toBe('UNKNOWN');
  });

  it('resolves an attempt left unfinished by a crashed worker before sending again', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, {
      recipient: recipients.healthy,
      status: 'RETRYING',
      attemptCount: 1,
      nextAttemptAt: new Date(),
    });
    await database.insertUnresolvedSendAttempt(fixture.applicationId, notificationId, 1);

    const result = await dispatch(fixture, notificationId);
    const attempts = await database.listSendAttempts(notificationId);
    const notification = await readNotification(notificationId);

    // The crashed attempt is settled as unknown and no new send happens in this
    // pass: acknowledging the ambiguity comes before acting on it.
    expect(result.outcome).toBe('retry_scheduled');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('UNKNOWN');
    expect(notification.providerMessageId).toBeNull();
  });

  it('fails closed on a crashed attempt when the application asked for that', async () => {
    const fixture = await createConnectedTenant({ unknownOutcomePolicy: 'FAIL_CLOSED' });
    const notificationId = await queueNotification(fixture, {
      recipient: recipients.healthy,
      status: 'RETRYING',
      attemptCount: 1,
      nextAttemptAt: new Date(),
    });
    await database.insertUnresolvedSendAttempt(fixture.applicationId, notificationId, 1);

    const result = await dispatch(fixture, notificationId);

    expect(result.outcome).toBe('failed');
    const notification = await readNotification(notificationId);

    expect(notification.failureCode).toBe('unknown_outcome_fail_closed');
  });
});

describe('conditions that are not the message', () => {
  it('waits without spending an attempt while WhatsApp is disconnected', async () => {
    const fixture = await createConnectedTenant({ sessionStatus: 'SCAN_QR_CODE' });
    const notificationId = await queueNotification(fixture, { recipient: recipients.healthy });

    const before = Date.now();
    const result = await dispatch(fixture, notificationId);
    const notification = await readNotification(notificationId);

    expect(result.outcome).toBe('retry_scheduled');
    expect(notification.failureCode).toBe('session_not_ready');
    // No attempt is consumed, so a disconnection of any length is survivable
    // and the backlog flows again as soon as somebody reconnects.
    expect(notification.attemptCount).toBe(0);
    expect(notification.nextAttemptAt?.getTime()).toBeGreaterThan(before + 60_000);
  });

  it('defers the second send on a session without spending an attempt', async () => {
    const fixture = await createConnectedTenant({ pacingSeconds: 45 });
    const first = await queueNotification(fixture, { recipient: recipients.healthy });
    const second = await queueNotification(fixture, { recipient: recipients.healthy });

    await dispatch(fixture, first);
    const result = await dispatch(fixture, second);
    const notification = await readNotification(second);

    expect(result.outcome).toBe('deferred');
    expect(result.detail).toBe('send_pacing');
    expect(notification.status).toBe('RETRYING');
    expect(notification.attemptCount).toBe(0);
    // Pacing is a decision about WhatsApp, not something that happened to the
    // message, so it must not clutter the delivery history.
    expect(await database.listEventTypes(second)).not.toContain('notification.retry_scheduled');
  });

  it('fails a notification that outlived its delivery window', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, {
      recipient: recipients.healthy,
      createdAt: new Date(Date.now() - 48 * 3_600_000),
    });

    const result = await dispatch(fixture, notificationId);

    expect(result.outcome).toBe('failed');
    const notification = await readNotification(notificationId);

    expect(notification.failureCode).toBe('delivery_window_expired');
  });

  it('refuses to dispatch a notification that was cancelled', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, {
      recipient: recipients.healthy,
      status: 'CANCELLED',
    });

    const result = await dispatch(fixture, notificationId);

    expect(result.outcome).toBe('not_claimable');
    const notification = await readNotification(notificationId);

    expect(notification.status).toBe('CANCELLED');
  });

  it('leaves a scheduled notification alone until its time comes', async () => {
    const fixture = await createConnectedTenant();
    const scheduledAt = new Date(Date.now() + 3_600_000);
    const notificationId = await queueNotification(fixture, {
      recipient: recipients.healthy,
      status: 'SCHEDULED',
      scheduledAt,
    });

    const result = await dispatch(fixture, notificationId);

    expect(result.outcome).toBe('deferred');
    expect(result.detail).toBe('not_yet_scheduled');
    const notification = await readNotification(notificationId);

    expect(notification.status).toBe('SCHEDULED');
    // Rescheduled rather than dropped, so an early job cannot strand the
    // notification with nothing left to dispatch it.
    expect(await database.countDispatchJobs(notificationId)).toBe(1);
  });

  it('promotes and sends a scheduled notification once it is due', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, {
      recipient: recipients.healthy,
      status: 'SCHEDULED',
      scheduledAt: new Date(Date.now() - 1000),
    });

    const result = await dispatch(fixture, notificationId);

    expect(result.outcome).toBe('sent');
    expect(await database.listEventTypes(notificationId)).toContain('notification.queued');
  });
});

describe('two workers racing for the same notification', () => {
  it('sends it exactly once', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.healthy });

    const results = await Promise.all([
      dispatch(fixture, notificationId),
      dispatch(fixture, notificationId),
      dispatch(fixture, notificationId),
    ]);
    const attempts = await database.listSendAttempts(notificationId);

    // The compare-and-swap claim is the guard, not the queue's deduplication.
    expect(results.filter((result) => result.outcome === 'sent')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'not_claimable')).toHaveLength(2);
    expect(attempts).toHaveLength(1);
  });
});

describe('maintenance', () => {
  it('returns an abandoned claim to the queue without spending an attempt', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, {
      recipient: recipients.healthy,
      status: 'PROCESSING',
    });
    await database.ageClaim(notificationId, configuration.delivery.stuckClaimTimeoutSeconds + 60);

    const report = await maintenance.runOnce();
    const notification = await readNotification(notificationId);

    expect(report.reapedClaims).toBe(1);
    expect(notification.status).toBe('RETRYING');
    expect(notification.attemptCount).toBe(0);
    expect(await database.listEventTypes(notificationId)).toContain('notification.claim_reaped');
  });

  it('leaves a claim that is still fresh alone', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, {
      recipient: recipients.healthy,
      status: 'PROCESSING',
    });

    const report = await maintenance.runOnce();

    expect(report.reapedClaims).toBe(0);
    const notification = await readNotification(notificationId);

    expect(notification.status).toBe('PROCESSING');
  });

  it('re-enqueues a notification whose dispatch job was lost', async () => {
    const fixture = await createConnectedTenant();
    const notificationId = await queueNotification(fixture, { recipient: recipients.healthy });

    const report = await maintenance.runOnce();

    expect(report.requeuedNotifications).toBe(1);
    expect(await database.countDispatchJobs(notificationId)).toBe(1);
  });
});
