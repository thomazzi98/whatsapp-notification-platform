import { buildOpenApiDocument } from '@platform/contracts';
import {
  connectToTestDatabase,
  createTestConfiguration,
  type TestDatabaseHandle,
} from '@platform/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { ApiModule } from '../api.module';
import { configureHttp } from '../http/configure-http';

/**
 * The boundary a separate service consumes, exercised the way it will consume it.
 *
 * A payment gateway integrating with this platform must need one base URL and
 * one API key, and nothing else: no database, no shared tables, no shared
 * packages, and no knowledge of which provider actually carries the message.
 * That is a property of the responses, not of an intention, so it is asserted
 * here — the client below deliberately holds nothing but a URL and a key, and
 * every field it receives is checked against the published document.
 *
 * These tests are the reason the contract can be treated as stable while the
 * two repositories stay separate. Breaking one of them is a breaking change for
 * a consumer, whether or not the consumer exists yet.
 */
const document = buildOpenApiDocument({ publicBaseUrl: 'http://localhost:8080' }) as {
  components: { schemas: Record<string, { properties: Record<string, unknown> }> };
};

const notificationFields = Object.keys(document.components.schemas.Notification?.properties ?? {});
const eventFields = Object.keys(document.components.schemas.NotificationEvent?.properties ?? {});

/**
 * Vocabulary that belongs inside the provider adapter. A consumer that learned
 * any of it would be coupled to WAHA through this API, which is the coupling the
 * provider port exists to prevent.
 *
 * `whatsAppSessionId` is deliberately not on this list. Which connection a
 * message is sent from is the platform's own concept -- a tenant may pair
 * several numbers and choose between them -- and it is a documented field. What
 * must not cross is WAHA's own shapes: chat identifiers, engine names, the
 * provider's session name, and the numeric acknowledgement codes.
 */
const providerVocabulary = [
  'chatid',
  '@c.us',
  '@s.whatsapp.net',
  'waha',
  'jid',
  'engine',
  'pushname',
];

let application: NestFastifyApplication;
let database: TestDatabaseHandle;
let tenantCounter = 0;

interface Consumer {
  readonly baseHeaders: Record<string, string>;
  readonly applicationId: string;
}

interface JsonResponse {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly body: Record<string, unknown>;
}

/** Everything a consuming service is allowed to need: a key, a path, a body. */
async function call(options: {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly payload?: unknown;
}): Promise<JsonResponse> {
  const response = await application.inject({
    method: options.method,
    url: options.url,
    headers: options.headers ?? {},
    payload: options.payload as never,
  });

  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body.length > 0 ? response.json<Record<string, unknown>>() : {},
  };
}

beforeAll(async () => {
  const connectionUrl = inject('databaseUrl');
  const configuration = createTestConfiguration(connectionUrl);
  database = connectToTestDatabase(connectionUrl);

  const moduleReference = await Test.createTestingModule({
    imports: [ApiModule.forConfiguration(configuration)],
  }).compile();

  // The production HTTP stack, parser included: this suite stands in for a real
  // client, so it has to meet what a real client meets.
  application = moduleReference.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { bodyParser: false },
  );
  await configureHttp(application, {
    logger: pino({ level: 'silent' }),
    publicBaseUrl: configuration.http.publicBaseUrl,
  });
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
}, 180_000);

afterAll(async () => {
  await application.close();
  await database.close();
});

beforeEach(async () => {
  await database.truncateAllTables();
});

/**
 * Provisioning is an operator task on the dashboard, not part of the contract a
 * consuming service uses. It is done here through the same screens a person
 * would, so the key under test is a real one.
 */
async function provisionConsumer(
  scopes: string[] = ['notifications:write', 'notifications:read'],
): Promise<Consumer> {
  tenantCounter += 1;
  const registered = await call({
    method: 'POST',
    url: '/dashboard/auth/register',
    payload: {
      organizationName: `Consumer ${String(tenantCounter)}`,
      name: 'Operator',
      email: `consumer-${String(tenantCounter)}@example.com`,
      password: 'a-long-enough-password',
    },
  });
  const rawCookie = registered.headers['set-cookie'];
  const cookie = String(Array.isArray(rawCookie) ? rawCookie[0] : rawCookie).split(';', 1)[0] ?? '';
  const dashboard = { cookie, 'x-csrf-token': registered.body.csrfToken as string };

  const created = await call({
    method: 'POST',
    url: '/dashboard/applications',
    headers: dashboard,
    payload: { name: 'Payments', slug: `payments-${String(tenantCounter)}` },
  });
  const applicationId = created.body.id as string;

  const key = await call({
    method: 'POST',
    url: `/dashboard/applications/${applicationId}/api-keys`,
    headers: dashboard,
    payload: { name: 'payment-gateway', scopes },
  });

  await database.insertWhatsAppSession(applicationId, `consumer-session-${String(tenantCounter)}`);

  return {
    applicationId,
    baseHeaders: { authorization: `Bearer ${String(key.body.plaintextKey)}` },
  };
}

async function requestNotification(
  consumer: Consumer,
  options: { readonly idempotencyKey?: string; readonly body?: string } = {},
): Promise<JsonResponse> {
  return call({
    method: 'POST',
    url: '/v1/notifications',
    headers: {
      ...consumer.baseHeaders,
      ...(options.idempotencyKey !== undefined && { 'idempotency-key': options.idempotencyKey }),
    },
    payload: {
      recipient: '+5511999998888',
      body: options.body ?? 'Payment approved for order ORD-4471.',
    },
  });
}

/** The partners in the scenario the batch endpoint exists for: one sale, three people. */
const partners = ['+5511999990001', '+5511999990002', '+5511999990003'];

async function requestBatch(
  consumer: Consumer,
  options: {
    readonly recipients?: readonly string[];
    readonly idempotencyKey?: string;
    readonly body?: string;
  } = {},
): Promise<JsonResponse> {
  return call({
    method: 'POST',
    url: '/v1/notifications/batch',
    headers: {
      ...consumer.baseHeaders,
      ...(options.idempotencyKey !== undefined && { 'idempotency-key': options.idempotencyKey }),
    },
    payload: {
      recipients: options.recipients ?? partners,
      body: options.body ?? 'Nova venda: pedido ORD-4471 aprovado.',
    },
  });
}

function notificationIdsOf(response: JsonResponse): string[] {
  return (response.body.data as { id: string }[]).map((notification) => notification.id);
}

async function countNotifications(consumer: Consumer): Promise<number> {
  const listed = await call({
    method: 'GET',
    url: '/v1/notifications',
    headers: consumer.baseHeaders,
  });

  return (listed.body.data as unknown[]).length;
}

describe('what a consuming service needs to send a notification', () => {
  it('accepts a bearer key and a body, and nothing else', async () => {
    const consumer = await provisionConsumer();

    const response = await requestNotification(consumer);

    // 202: persisted and queued. A consumer that treated this as "delivered"
    // would be wrong, and the contract says so through the status alone.
    expect(response.statusCode).toBe(202);
    expect(response.body.status).toBe('QUEUED');
  });

  it('refuses an unauthenticated caller without revealing anything', async () => {
    const response = await call({
      method: 'POST',
      url: '/v1/notifications',
      payload: { recipient: '+5511999998888', body: 'No key.' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses a key that was issued without the write scope', async () => {
    const readOnly = await provisionConsumer(['notifications:read']);

    const response = await requestNotification(readOnly);

    expect(response.statusCode).toBe(403);
  });
});

describe('telling several people about one event', () => {
  it('creates one notification per recipient, in the order they were given', async () => {
    const consumer = await provisionConsumer();

    const response = await requestBatch(consumer);
    const data = response.body.data as { id: string; recipient: string; status: string }[];

    expect(response.statusCode).toBe(202);
    expect(data.map((notification) => notification.recipient)).toStrictEqual(partners);
    expect(new Set(data.map((notification) => notification.id)).size).toBe(partners.length);
    expect(data.every((notification) => notification.status === 'QUEUED')).toBe(true);
  });

  it('describes each notification only in fields the document publishes', async () => {
    const consumer = await provisionConsumer();

    const response = await requestBatch(consumer);
    const [first] = response.body.data as Record<string, unknown>[];

    expect(Object.keys(first ?? {})).toStrictEqual(
      Object.keys(first ?? {}).filter((field) => notificationFields.includes(field)),
    );
  });

  it('replays the whole batch under one key rather than sending it twice', async () => {
    const consumer = await provisionConsumer();
    const key = 'sale-ORD-4471';

    const first = await requestBatch(consumer, { idempotencyKey: key });
    const second = await requestBatch(consumer, { idempotencyKey: key });

    expect(notificationIdsOf(second)).toStrictEqual(notificationIdsOf(first));
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await countNotifications(consumer)).toBe(partners.length);
  });

  it('creates each recipient once when the same batch arrives several times at once', async () => {
    const consumer = await provisionConsumer();
    const key = 'sale-ORD-4471-at-once';

    const responses = await Promise.all(
      Array.from({ length: 5 }, async () => requestBatch(consumer, { idempotencyKey: key })),
    );

    // One sale, three partners: three notifications, however many times the
    // gateway's retry fired. Every caller is told the truth -- accepted, or the
    // identical batch it duplicates is still in flight.
    expect(await countNotifications(consumer)).toBe(partners.length);
    for (const response of responses) {
      expect([202, 409]).toContain(response.statusCode);
    }
  });

  it('refuses a batch that names someone twice, rather than messaging them twice', async () => {
    const consumer = await provisionConsumer();

    const response = await requestBatch(consumer, {
      recipients: ['+5511999990001', '+5511999990002', '+5511999990001'],
    });

    expect(response.statusCode).toBe(400);
    expect(await countNotifications(consumer)).toBe(0);
  });

  it('creates none of them when one recipient is invalid', async () => {
    const consumer = await provisionConsumer();

    const response = await requestBatch(consumer, {
      recipients: ['+5511999990001', 'not-a-phone-number'],
    });

    // All or nothing: a partial batch would leave the caller unable to tell
    // which partners were told and which were not.
    expect(response.statusCode).toBe(400);
    expect(await countNotifications(consumer)).toBe(0);
  });

  it('refuses more recipients than one batch may name', async () => {
    const consumer = await provisionConsumer();

    const response = await requestBatch(consumer, {
      recipients: Array.from(
        { length: 51 },
        (unused, index) => `+55119999${String(index).padStart(5, '0')}`,
      ),
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a key already used for a single notification', async () => {
    const consumer = await provisionConsumer();
    await requestNotification(consumer, { idempotencyKey: 'shared-between-endpoints' });

    const response = await requestBatch(consumer, { idempotencyKey: 'shared-between-endpoints' });

    expect(response.statusCode).toBe(422);
  });
});

describe('the identifiers a consuming service stores', () => {
  it('returns one it can use to ask again later', async () => {
    const consumer = await provisionConsumer();
    const accepted = await requestNotification(consumer);

    const read = await call({
      method: 'GET',
      url: `/v1/notifications/${String(accepted.body.id)}`,
      headers: consumer.baseHeaders,
    });

    expect(read.statusCode).toBe(200);
    expect(read.body.id).toBe(accepted.body.id);
  });

  it('collapses a retried request onto the identifier it already issued', async () => {
    const consumer = await provisionConsumer();
    // The gateway's own event identifier is the natural key: retrying a
    // "payment approved" must not send a second message.
    const key = 'payment-event-6f2c1e';

    const first = await requestNotification(consumer, { idempotencyKey: key });
    const second = await requestNotification(consumer, { idempotencyKey: key });

    expect(second.body.id).toBe(first.body.id);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('refuses the same key carrying a different message', async () => {
    const consumer = await provisionConsumer();
    const key = 'payment-event-6f2c1e';
    await requestNotification(consumer, { idempotencyKey: key, body: 'Payment approved.' });

    const changed = await requestNotification(consumer, {
      idempotencyKey: key,
      body: 'Payment refunded.',
    });

    // Answering with the first response would hide a real bug in the caller.
    expect(changed.statusCode).toBe(422);
  });
});

describe('what a consuming service is allowed to learn', () => {
  it('describes a notification only in fields the document publishes', async () => {
    const consumer = await provisionConsumer();
    const accepted = await requestNotification(consumer);

    expect(Object.keys(accepted.body)).toStrictEqual(
      Object.keys(accepted.body).filter((field) => notificationFields.includes(field)),
    );
  });

  it('describes a timeline entry only in fields the document publishes', async () => {
    const consumer = await provisionConsumer();
    const accepted = await requestNotification(consumer);

    const events = await call({
      method: 'GET',
      url: `/v1/notifications/${String(accepted.body.id)}/events`,
      headers: consumer.baseHeaders,
    });
    const [entry] = events.body.data as Record<string, unknown>[];

    expect(Object.keys(entry ?? {})).toStrictEqual(
      Object.keys(entry ?? {}).filter((field) => eventFields.includes(field)),
    );
  });

  it('never names the provider carrying the message', async () => {
    const consumer = await provisionConsumer();
    const accepted = await requestNotification(consumer);
    const events = await call({
      method: 'GET',
      url: `/v1/notifications/${String(accepted.body.id)}/events`,
      headers: consumer.baseHeaders,
    });

    // A consumer that learned a chat identifier or a session name would be
    // coupled to WhatsApp through this API, which is the coupling the provider
    // port exists to prevent.
    const serialised =
      `${JSON.stringify(accepted.body)}${JSON.stringify(events.body)}`.toLowerCase();
    for (const term of providerVocabulary) {
      expect(serialised).not.toContain(term);
    }
  });

  it('cannot read a notification belonging to another application', async () => {
    const owner = await provisionConsumer();
    const other = await provisionConsumer();
    const accepted = await requestNotification(owner);

    const read = await call({
      method: 'GET',
      url: `/v1/notifications/${String(accepted.body.id)}`,
      headers: other.baseHeaders,
    });

    // 404 rather than 403: a consumer must not be able to discover that an
    // identifier exists in another tenant.
    expect(read.statusCode).toBe(404);
  });
});

describe('how a consuming service discovers the contract', () => {
  it('serves the document without a key, so a client can be generated from it', async () => {
    const response = await call({ method: 'GET', url: '/v1/openapi.json' });

    expect(response.statusCode).toBe(200);
    expect(response.body.openapi).toBeTypeOf('string');
  });

  it('tells a key what it may do, without sending a message to find out', async () => {
    const consumer = await provisionConsumer();

    const response = await call({
      method: 'GET',
      url: '/v1/applications/current',
      headers: consumer.baseHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.id).toBe(consumer.applicationId);
    expect(response.body.scopes).toStrictEqual(['notifications:write', 'notifications:read']);
  });
});

describe('how a consuming service is told it went wrong', () => {
  it('answers every failure in one documented shape', async () => {
    const consumer = await provisionConsumer();

    const invalid = await call({
      method: 'POST',
      url: '/v1/notifications',
      headers: consumer.baseHeaders,
      payload: { recipient: 'not-a-phone-number', body: 'x' },
    });

    expect(invalid.statusCode).toBe(400);
    expect(String(invalid.headers['content-type'])).toContain('application/problem+json');
    expect(invalid.body.type).toBeTypeOf('string');
    expect(invalid.body.title).toBeTypeOf('string');
    expect(invalid.body.status).toBe(400);
    expect(invalid.body.detail).toBeTypeOf('string');
    // Which field, and why: a consuming service should not have to parse prose
    // to find out what it sent wrong.
    expect(invalid.body.errors).toBeInstanceOf(Array);
  });

  it('refuses a body that is not UTF-8, rather than delivering it garbled', async () => {
    const consumer = await provisionConsumer();
    // "notificações" as a Windows terminal in the ANSI code page sends it: the
    // two accented letters are single bytes that are not valid UTF-8. Decoding
    // leniently turned them into U+FFFD, answered 202, and the recipient read
    // "notifica��es".
    const latin1 = Buffer.concat([
      Buffer.from('{"recipient":"+5511999998888","body":"notifica'),
      Buffer.from([0xe7, 0xf5]),
      Buffer.from('es"}'),
    ]);

    const response = await application.inject({
      method: 'POST',
      url: '/v1/notifications',
      headers: { ...consumer.baseHeaders, 'content-type': 'application/json' },
      payload: latin1,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<Record<string, unknown>>().detail).toMatch(/utf-8/i);
  });

  it('delivers accented text and emoji exactly as they were sent', async () => {
    const consumer = await provisionConsumer();

    const accepted = await requestNotification(consumer, {
      body: 'Pagamento aprovado ✅ — ação concluída',
    });
    const read = await call({
      method: 'GET',
      url: `/v1/notifications/${String(accepted.body.id)}`,
      headers: consumer.baseHeaders,
    });

    expect(read.body.body).toBe('Pagamento aprovado ✅ — ação concluída');
  });

  it('refuses a body that tries to set an object prototype', async () => {
    const consumer = await provisionConsumer();

    const response = await application.inject({
      method: 'POST',
      url: '/v1/notifications',
      headers: { ...consumer.baseHeaders, 'content-type': 'application/json' },
      payload:
        '{"recipient":"+5511999998888","body":"x","metadata":{"__proto__":{"polluted":"yes"}}}',
    });

    // Fastify's own parser refuses this; a bare JSON.parse accepted it.
    expect(response.statusCode).toBe(400);
  });

  it('paces a consumer with standard headers rather than only refusing it', async () => {
    const consumer = await provisionConsumer();

    const response = await requestNotification(consumer);

    expect(response.headers['ratelimit-limit']).toBeDefined();
    expect(response.headers['ratelimit-remaining']).toBeDefined();
    expect(response.headers['ratelimit-reset']).toBeDefined();
  });
});
