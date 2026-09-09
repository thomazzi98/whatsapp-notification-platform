import { createHmac } from 'node:crypto';
import { type AddressInfo, createServer } from 'node:net';

import {
  connectToTestDatabase,
  createTestConfiguration,
  type TestDatabaseHandle,
} from '@platform/testing';
import { createStubServer } from '@platform/waha-stub';
import fastifyCookie from '@fastify/cookie';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { ApiModule } from '../api.module';
import { registerCorrelationHook } from '../http/correlation/correlation.hook';
import { ProblemDetailsFilter } from '../http/filters/problem-details.filter';
import { registerRawBodyParser } from '../http/raw-body';

const stubApiKey = 'webhook-integration-stub-key';

let application: NestFastifyApplication;
let database: TestDatabaseHandle;
let stub: FastifyInstance;
let stubBaseUrl: string;
let apiBaseUrl: string;

/**
 * A port nothing is listening on yet.
 *
 * The API's own address has to be known before it is built, because the webhook
 * URL handed to the provider is part of its configuration — so the port is
 * reserved first and bound afterwards.
 */
async function reservePort(): Promise<number> {
  const probe = createServer();

  await new Promise<void>((resolve) => {
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });

  return port;
}

beforeAll(async () => {
  const connectionUrl = inject('databaseUrl');
  database = connectToTestDatabase(connectionUrl);

  stub = createStubServer({ apiKey: stubApiKey });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  stubBaseUrl = `http://127.0.0.1:${String((stub.server.address() as AddressInfo).port)}`;

  const port = await reservePort();
  apiBaseUrl = `http://127.0.0.1:${String(port)}`;
  const configuration = createTestConfiguration(connectionUrl, {
    whatsAppProvider: {
      baseUrl: stubBaseUrl,
      apiKey: stubApiKey,
      requestTimeoutMilliseconds: 2000,
      webhookPublicUrl: apiBaseUrl,
      webhookToleranceSeconds: 300,
    },
  });

  const moduleReference = await Test.createTestingModule({
    imports: [ApiModule.forConfiguration(configuration)],
  }).compile();

  application = moduleReference.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    {
      bodyParser: false,
    },
  );
  await application.register(fastifyCookie);
  registerRawBodyParser(application.getHttpAdapter().getInstance());
  registerCorrelationHook(application.getHttpAdapter().getInstance(), {
    info: () => undefined,
    debug: () => undefined,
  } as never);
  application.useGlobalFilters(
    new ProblemDetailsFilter(
      { error: () => undefined, info: () => undefined } as never,
      configuration.http.publicBaseUrl,
    ),
  );
  await application.init();
  // Listening for real, because the point of this suite is that the provider
  // reaches the API over the network with a signature it computed itself.
  await application.listen(port, '127.0.0.1');
}, 180_000);

afterAll(async () => {
  await application.close();
  await stub.close();
  await database.close();
});

beforeEach(async () => {
  await database.truncateAllTables();
  await fetch(`${stubBaseUrl}/__stub/reset`, { method: 'POST' });
});

interface Tenant {
  readonly applicationId: string;
  readonly cookie: string;
  readonly csrfToken: string;
}

let tenantCounter = 0;

async function dashboardRequest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options: { readonly body?: unknown; readonly tenant?: Tenant } = {},
): Promise<{ statusCode: number; body: Record<string, unknown>; setCookie: string | undefined }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.tenant !== undefined) {
    headers.cookie = options.tenant.cookie;
    headers['x-csrf-token'] = options.tenant.csrfToken;
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers,
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();

  return {
    statusCode: response.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
    setCookie: response.headers.get('set-cookie') ?? undefined,
  };
}

async function createTenant(): Promise<Tenant> {
  tenantCounter += 1;
  const registered = await dashboardRequest('POST', '/dashboard/auth/register', {
    body: {
      organizationName: `Webhook tenant ${String(tenantCounter)}`,
      name: 'Owner',
      email: `webhooks-${String(tenantCounter)}@example.com`,
      password: 'a-long-enough-password',
    },
  });
  const cookie = (registered.setCookie ?? '').split(';', 1)[0] ?? '';
  const tenant = { applicationId: '', cookie, csrfToken: registered.body.csrfToken as string };

  const created = await dashboardRequest('POST', '/dashboard/applications', {
    body: { name: 'Store', slug: `store-${String(tenantCounter)}` },
    tenant,
  });

  return { ...tenant, applicationId: created.body.id as string };
}

interface Connection {
  readonly tenant: Tenant;
  readonly sessionId: string;
  readonly providerSessionName: string;
}

/** Creates a connection through the dashboard, so the stub holds the real signing key. */
async function createConnection(): Promise<Connection> {
  const tenant = await createTenant();
  const created = await dashboardRequest(
    'POST',
    `/dashboard/applications/${tenant.applicationId}/whatsapp-sessions`,
    { body: { displayName: 'Storefront line' }, tenant },
  );
  const sessionId = created.body.id as string;

  return { tenant, sessionId, providerSessionName: `wnp-${sessionId}` };
}

async function readStubSigningKey(providerSessionName: string): Promise<string> {
  const response = await fetch(`${stubBaseUrl}/__stub/state`);
  const state = (await response.json()) as {
    sessions: { name: string; webhooks: { hmac?: { key?: string } }[] }[];
  };
  const session = state.sessions.find((candidate) => candidate.name === providerSessionName);
  const key = session?.webhooks[0]?.hmac?.key;

  if (key === undefined) {
    throw new Error(`The stub holds no signing key for ${providerSessionName}.`);
  }
  return key;
}

async function postCallback(
  sessionId: string,
  body: string,
  headers: Record<string, string>,
): Promise<number> {
  const response = await fetch(`${apiBaseUrl}/webhooks/whatsapp/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

  return response.status;
}

describe('connecting WhatsApp', () => {
  it('creates the connection at the provider with a callback URL of its own', async () => {
    const connection = await createConnection();
    const response = await fetch(`${stubBaseUrl}/__stub/state`);
    const state = (await response.json()) as {
      sessions: { name: string; webhooks: { url: string }[] }[];
    };
    const session = state.sessions.find(
      (candidate) => candidate.name === connection.providerSessionName,
    );

    expect(session?.webhooks[0]?.url).toBe(
      `${apiBaseUrl}/webhooks/whatsapp/${connection.sessionId}`,
    );
  });

  it('removes it from the provider before forgetting about it', async () => {
    const connection = await createConnection();

    const removed = await dashboardRequest(
      'DELETE',
      `/dashboard/applications/${connection.tenant.applicationId}/whatsapp-sessions/${connection.sessionId}`,
      { tenant: connection.tenant },
    );

    expect(removed.statusCode).toBe(204);
    // Forgetting the row locally is the easy half. Without the provider call,
    // a paired WhatsApp account keeps running against a connection the platform
    // no longer knows about, still receiving messages nobody reads.
    const stubState = await fetch(`${stubBaseUrl}/__stub/state`);
    const state = (await stubState.json()) as { sessions: { name: string }[] };
    expect(state.sessions.map((session) => session.name)).not.toContain(
      connection.providerSessionName,
    );

    const read = await dashboardRequest(
      'GET',
      `/dashboard/applications/${connection.tenant.applicationId}/whatsapp-sessions/${connection.sessionId}`,
      { tenant: connection.tenant },
    );
    expect(read.statusCode).toBe(404);
  });

  it('never returns the signing key or the provider session name', async () => {
    const connection = await createConnection();
    const listed = await dashboardRequest(
      'GET',
      `/dashboard/applications/${connection.tenant.applicationId}/whatsapp-sessions`,
      { tenant: connection.tenant },
    );

    const serialised = JSON.stringify(listed.body);
    expect(serialised).not.toContain(await readStubSigningKey(connection.providerSessionName));
    expect(serialised).not.toContain(connection.providerSessionName);
  });

  it('reports it as waiting for a code before anyone scans', async () => {
    const connection = await createConnection();
    const read = await dashboardRequest(
      'GET',
      `/dashboard/applications/${connection.tenant.applicationId}/whatsapp-sessions/${connection.sessionId}`,
      { tenant: connection.tenant },
    );

    expect(read.body.status).toBe('SCAN_QR_CODE');
    expect(read.body.phoneNumber).toBeNull();
  });

  it('offers a code to scan while the provider is waiting for one', async () => {
    const connection = await createConnection();
    const code = await dashboardRequest(
      'GET',
      `/dashboard/applications/${connection.tenant.applicationId}/whatsapp-sessions/${connection.sessionId}/qr-code`,
      { tenant: connection.tenant },
    );

    expect(code.statusCode).toBe(200);
    expect(code.body.mimeType).toBe('image/png');
  });

  it('refuses to offer a code once the connection is paired', async () => {
    const connection = await createConnection();
    await fetch(`${stubBaseUrl}/__stub/sessions/${connection.providerSessionName}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '5511999990000' }),
    });

    const code = await dashboardRequest(
      'GET',
      `/dashboard/applications/${connection.tenant.applicationId}/whatsapp-sessions/${connection.sessionId}/qr-code`,
      { tenant: connection.tenant },
    );

    // Offering an action that cannot succeed is worse than refusing it.
    expect(code.statusCode).toBe(409);
  });

  it("refuses to read another tenant's connection", async () => {
    const connection = await createConnection();
    const intruder = await createTenant();

    const read = await dashboardRequest(
      'GET',
      `/dashboard/applications/${intruder.applicationId}/whatsapp-sessions/${connection.sessionId}`,
      { tenant: intruder },
    );

    // 404 rather than 403: confirming the identifier exists would be an answer.
    expect(read.statusCode).toBe(404);
  });
});

describe('receiving a provider callback', () => {
  it('accepts one the provider signed and delivered itself', async () => {
    const connection = await createConnection();

    // The stub signs and POSTs to the URL it was given, so this exercises the
    // real path rather than a signature the test computed.
    await fetch(`${stubBaseUrl}/__stub/sessions/${connection.providerSessionName}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '5511999990000' }),
    });

    const deliveries = await database.listWebhookDeliveries(connection.tenant.applicationId);
    expect(deliveries.map((delivery) => delivery.eventType)).toContain('session.status');
  });

  it('records an acknowledgement the provider sent', async () => {
    const connection = await createConnection();
    await fetch(`${stubBaseUrl}/__stub/sessions/${connection.providerSessionName}/acknowledge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'true_5511999990000@c.us_STUB000001', ack: 3 }),
    });

    const deliveries = await database.listWebhookDeliveries(connection.tenant.applicationId);
    expect(deliveries.map((delivery) => delivery.eventType)).toContain('message.ack');
  });

  it('leaves a job behind, because storing a callback nobody processes changes nothing', async () => {
    const connection = await createConnection();
    const before = await database.countJobsOnQueue('webhook.process');

    await fetch(`${stubBaseUrl}/__stub/sessions/${connection.providerSessionName}/acknowledge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'true_5511999990000@c.us_STUB000002', ack: 2 }),
    });

    // Every other assertion here stops at the inbox row. Deleting the enqueue
    // would leave the delivery recorded, the endpoint answering 202, and the
    // acknowledgement never applied — visible only in the end-to-end suite.
    expect(await database.countJobsOnQueue('webhook.process')).toBeGreaterThan(before);
  });

  it('refuses a callback for a connection whose signing key cannot be read', async () => {
    // A rotated encryption key or a damaged row is an operator problem, but the
    // caller must not be able to tell it apart from a wrong signature.
    const applicationId = await database.insertApplication();
    const sessionId = await database.insertWhatsAppSession(applicationId, 'unreadable-key-session');

    const status = await postCallback(sessionId, '{}', { 'x-webhook-hmac': 'anything' });

    expect(status).toBe(401);
  });

  it('refuses a callback with no signature', async () => {
    const connection = await createConnection();

    const status = await postCallback(
      connection.sessionId,
      JSON.stringify({
        id: 'event-1',
        session: connection.providerSessionName,
        event: 'message.ack',
        payload: {},
      }),
      {},
    );

    expect(status).toBe(401);
  });

  it('refuses a callback signed with the wrong key', async () => {
    const connection = await createConnection();
    const body = JSON.stringify({
      id: 'event-2',
      session: connection.providerSessionName,
      event: 'message.ack',
      payload: { id: 'message-1', ack: 2 },
    });

    const status = await postCallback(connection.sessionId, body, {
      'x-webhook-hmac': createHmac('sha512', 'the-wrong-key').update(body).digest('hex'),
    });

    expect(status).toBe(401);
  });

  it('refuses a body altered after it was signed', async () => {
    const connection = await createConnection();
    const signingKey = await readStubSigningKey(connection.providerSessionName);
    const signed = JSON.stringify({
      id: 'event-3',
      session: connection.providerSessionName,
      event: 'message.ack',
      payload: { id: 'message-1', ack: 2 },
    });
    const tampered = signed.replace('"ack":2', '"ack":3');

    const status = await postCallback(connection.sessionId, tampered, {
      'x-webhook-hmac': createHmac('sha512', signingKey).update(signed).digest('hex'),
    });

    expect(status).toBe(401);
  });

  it('answers an unknown session exactly like a bad signature', async () => {
    // Telling them apart would let a caller discover which sessions exist.
    const status = await postCallback('0193b0f0-0000-7000-8000-00000000dead', '{}', {
      'x-webhook-hmac': 'anything',
    });

    expect(status).toBe(401);
  });

  it('refuses a captured callback replayed later', async () => {
    const connection = await createConnection();
    const signingKey = await readStubSigningKey(connection.providerSessionName);
    const body = JSON.stringify({
      id: 'event-4',
      session: connection.providerSessionName,
      event: 'message.ack',
      payload: { id: 'message-1', ack: 2 },
    });

    const status = await postCallback(connection.sessionId, body, {
      'x-webhook-hmac': createHmac('sha512', signingKey).update(body).digest('hex'),
      'x-webhook-timestamp': String(Date.now() - 3_600_000),
    });

    expect(status).toBe(401);
  });

  it('accepts a redelivery without recording it twice', async () => {
    const connection = await createConnection();
    const signingKey = await readStubSigningKey(connection.providerSessionName);
    const body = JSON.stringify({
      id: 'event-5',
      session: connection.providerSessionName,
      event: 'message.ack',
      payload: { id: 'message-1', ack: 2 },
    });
    const signature = createHmac('sha512', signingKey).update(body).digest('hex');

    const first = await postCallback(connection.sessionId, body, { 'x-webhook-hmac': signature });
    const second = await postCallback(connection.sessionId, body, { 'x-webhook-hmac': signature });

    // A redelivery is ordinary provider behaviour, so it succeeds — and files
    // nothing, which is what makes it harmless.
    expect([first, second]).toEqual([202, 202]);
    const deliveries = await database.listWebhookDeliveries(connection.tenant.applicationId);
    expect(deliveries.filter((delivery) => delivery.providerEventId === 'event-5')).toHaveLength(1);
  });

  it('refuses a body that is signed but is not an envelope', async () => {
    const connection = await createConnection();
    const signingKey = await readStubSigningKey(connection.providerSessionName);
    const body = JSON.stringify({ nothing: 'useful' });

    const status = await postCallback(connection.sessionId, body, {
      'x-webhook-hmac': createHmac('sha512', signingKey).update(body).digest('hex'),
    });

    expect(status).toBe(400);
  });
});
