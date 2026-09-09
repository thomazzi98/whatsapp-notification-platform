import { buildOpenApiDocument } from '@platform/contracts';
import {
  connectToTestDatabase,
  createTestConfiguration,
  type TestDatabaseHandle,
} from '@platform/testing';
import fastifyCookie from '@fastify/cookie';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { ApiModule } from '../api.module';
import { ProblemDetailsFilter } from '../http/filters/problem-details.filter';

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

  application = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await application.register(fastifyCookie);
  application.useGlobalFilters(
    new ProblemDetailsFilter(
      { error: () => undefined, info: () => undefined } as never,
      configuration.http.publicBaseUrl,
    ),
  );
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

  it('paces a consumer with standard headers rather than only refusing it', async () => {
    const consumer = await provisionConsumer();

    const response = await requestNotification(consumer);

    expect(response.headers['ratelimit-limit']).toBeDefined();
    expect(response.headers['ratelimit-remaining']).toBeDefined();
    expect(response.headers['ratelimit-reset']).toBeDefined();
  });
});
