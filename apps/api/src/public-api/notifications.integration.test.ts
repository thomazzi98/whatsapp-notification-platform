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

interface JsonResponse {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly body: Record<string, unknown>;
}

let application: NestFastifyApplication;
let database: TestDatabaseHandle;

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

async function request(options: {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly payload?: unknown;
  readonly cookie?: string;
  readonly csrfToken?: string;
  readonly bearerToken?: string;
  readonly idempotencyKey?: string;
}): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) {
    headers.cookie = options.cookie;
  }
  if (options.csrfToken !== undefined) {
    headers['x-csrf-token'] = options.csrfToken;
  }
  if (options.bearerToken !== undefined) {
    headers.authorization = `Bearer ${options.bearerToken}`;
  }
  if (options.idempotencyKey !== undefined) {
    headers['idempotency-key'] = options.idempotencyKey;
  }

  const response = await application.inject({
    method: options.method,
    url: options.url,
    headers,
    payload: options.payload as never,
  });

  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body.length > 0 ? response.json<Record<string, unknown>>() : {},
  };
}

interface Tenant {
  readonly applicationId: string;
  readonly apiKey: string;
  readonly cookie: string;
  readonly csrfToken: string;
}

let tenantCounter = 0;

/**
 * Builds a tenant through the real API rather than by writing rows, so the
 * fixtures exercise the same paths a customer would.
 */
async function createTenant(): Promise<Tenant> {
  tenantCounter += 1;
  const registered = await request({
    method: 'POST',
    url: '/dashboard/auth/register',
    payload: {
      organizationName: `Tenant ${String(tenantCounter)}`,
      name: 'Owner',
      email: `owner-${String(tenantCounter)}@example.com`,
      password: 'a-long-enough-password',
    },
  });

  const rawCookie = registered.headers['set-cookie'];
  const cookieHeader = String(Array.isArray(rawCookie) ? rawCookie[0] : rawCookie);
  const cookie = cookieHeader.split(';', 1)[0] ?? '';
  const csrfToken = registered.body.csrfToken as string;

  const created = await request({
    method: 'POST',
    url: '/dashboard/applications',
    payload: { name: 'Store', slug: 'store' },
    cookie,
    csrfToken,
  });
  const applicationId = created.body.id as string;

  const key = await request({
    method: 'POST',
    url: `/dashboard/applications/${applicationId}/api-keys`,
    payload: { name: 'backend', scopes: ['notifications:write', 'notifications:read'] },
    cookie,
    csrfToken,
  });

  await database.insertWhatsAppSession(applicationId, `session-${String(tenantCounter)}`);

  return { applicationId, apiKey: key.body.plaintextKey as string, cookie, csrfToken };
}

async function createNotification(
  tenant: Tenant,
  payload: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<JsonResponse> {
  return request({
    method: 'POST',
    url: '/v1/notifications',
    payload: { recipient: '+5511999998888', body: 'Your order has shipped.', ...payload },
    bearerToken: tenant.apiKey,
    ...(idempotencyKey !== undefined && { idempotencyKey }),
  });
}

describe('creating a notification', () => {
  it('accepts it for delivery rather than claiming it was delivered', async () => {
    const tenant = await createTenant();

    const response = await createNotification(tenant, {});

    // 202, not 200: it is persisted and queued, not delivered.
    expect(response.statusCode).toBe(202);
    expect(response.body.status).toBe('QUEUED');
    expect(response.body.attemptCount).toBe(0);
  });

  it('records the first timeline event', async () => {
    const tenant = await createTenant();
    const created = await createNotification(tenant, {});

    const events = await request({
      method: 'GET',
      url: `/v1/notifications/${String(created.body.id)}/events`,
      bearerToken: tenant.apiKey,
    });
    const eventTypes = (events.body.data as { eventType: string }[]).map(
      (event) => event.eventType,
    );

    expect(eventTypes).toContain('notification.created');
  });

  it('never writes the recipient into the timeline payload in full', async () => {
    const tenant = await createTenant();
    const created = await createNotification(tenant, { recipient: '+5511977776666' });

    const events = await request({
      method: 'GET',
      url: `/v1/notifications/${String(created.body.id)}/events`,
      bearerToken: tenant.apiKey,
    });

    expect(JSON.stringify(events.body)).not.toContain('5511977776666');
  });

  it('rejects a recipient that is not in international format', async () => {
    const tenant = await createTenant();

    const response = await createNotification(tenant, { recipient: '11999998888' });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an empty message', async () => {
    const tenant = await createTenant();

    const response = await createNotification(tenant, { body: '' });

    expect(response.statusCode).toBe(400);
  });

  it('requires the write scope', async () => {
    const tenant = await createTenant();
    const readOnly = await request({
      method: 'POST',
      url: `/dashboard/applications/${tenant.applicationId}/api-keys`,
      payload: { name: 'read-only', scopes: ['notifications:read'] },
      cookie: tenant.cookie,
      csrfToken: tenant.csrfToken,
    });

    const response = await request({
      method: 'POST',
      url: '/v1/notifications',
      payload: { recipient: '+5511999998888', body: 'Hello' },
      bearerToken: readOnly.body.plaintextKey as string,
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('scheduling', () => {
  it('holds a future notification in the scheduled state', async () => {
    const tenant = await createTenant();
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();

    const response = await createNotification(tenant, { scheduledAt });

    expect(response.body.status).toBe('SCHEDULED');
    expect(response.body.scheduledAt).toBeTypeOf('string');
  });

  it('rejects a schedule in the past rather than sending immediately', async () => {
    const tenant = await createTenant();
    const scheduledAt = new Date(Date.now() - 3_600_000).toISOString();

    const response = await createNotification(tenant, { scheduledAt });

    expect(response.statusCode).toBe(422);
  });
});

describe('idempotency', () => {
  it('returns the original notification for a repeated identical request', async () => {
    const tenant = await createTenant();
    const key = 'order-123-shipped';

    const first = await createNotification(tenant, {}, key);
    const second = await createNotification(tenant, {}, key);

    expect(second.statusCode).toBe(202);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('creates exactly one notification for a repeated request', async () => {
    const tenant = await createTenant();
    const key = 'order-123-shipped';

    await createNotification(tenant, {}, key);
    await createNotification(tenant, {}, key);
    await createNotification(tenant, {}, key);

    const listed = await request({
      method: 'GET',
      url: '/v1/notifications',
      bearerToken: tenant.apiKey,
    });

    expect((listed.body.data as unknown[]).length).toBe(1);
  });

  it('rejects the same key used with a different body', async () => {
    const tenant = await createTenant();
    const key = 'order-123-shipped';

    await createNotification(tenant, {}, key);
    const different = await createNotification(tenant, { body: 'A different message.' }, key);

    // Answering this with the first response would hide a real client bug.
    expect(different.statusCode).toBe(422);
  });

  it('does not mark the first response as a replay', async () => {
    const tenant = await createTenant();

    const first = await createNotification(tenant, {}, 'first-key');

    expect(first.headers['idempotent-replayed']).toBeUndefined();
  });

  it('scopes keys per application, so tenants cannot collide', async () => {
    const first = await createTenant();
    const second = await createTenant();
    const key = 'shared-key';

    const firstNotification = await createNotification(first, {}, key);
    const secondNotification = await createNotification(second, {}, key);

    expect(secondNotification.statusCode).toBe(202);
    expect(secondNotification.body.id).not.toBe(firstNotification.body.id);
  });

  it('treats a request without a key as a new notification every time', async () => {
    const tenant = await createTenant();

    await createNotification(tenant, {});
    await createNotification(tenant, {});

    const listed = await request({
      method: 'GET',
      url: '/v1/notifications',
      bearerToken: tenant.apiKey,
    });

    expect((listed.body.data as unknown[]).length).toBe(2);
  });
});

describe('reading notifications', () => {
  it('hides another application notifications', async () => {
    const first = await createTenant();
    const second = await createTenant();
    const created = await createNotification(first, {});

    const response = await request({
      method: 'GET',
      url: `/v1/notifications/${String(created.body.id)}`,
      bearerToken: second.apiKey,
    });

    expect(response.statusCode).toBe(404);
  });

  it('filters by status', async () => {
    const tenant = await createTenant();
    await createNotification(tenant, {});
    await createNotification(tenant, {
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const scheduled = await request({
      method: 'GET',
      url: '/v1/notifications?status=SCHEDULED',
      bearerToken: tenant.apiKey,
    });

    expect(
      (scheduled.body.data as { status: string }[]).every((row) => row.status === 'SCHEDULED'),
    ).toBe(true);
    expect((scheduled.body.data as unknown[]).length).toBe(1);
  });

  it('pages with a cursor', async () => {
    const tenant = await createTenant();
    for (let index = 0; index < 5; index += 1) {
      await createNotification(tenant, { body: `Message ${String(index)}` });
    }

    const firstPage = await request({
      method: 'GET',
      url: '/v1/notifications?limit=2',
      bearerToken: tenant.apiKey,
    });
    const secondPage = await request({
      method: 'GET',
      url: `/v1/notifications?limit=2&cursor=${encodeURIComponent(String(firstPage.body.nextCursor))}`,
      bearerToken: tenant.apiKey,
    });

    const firstIds = (firstPage.body.data as { id: string }[]).map((row) => row.id);
    const secondIds = (secondPage.body.data as { id: string }[]).map((row) => row.id);

    expect(firstIds).toHaveLength(2);
    expect(secondIds).toHaveLength(2);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });

  it('rejects a tampered cursor rather than running a confusing query', async () => {
    const tenant = await createTenant();
    await createNotification(tenant, {});

    const response = await request({
      method: 'GET',
      url: '/v1/notifications?cursor=bm90LWEtcmVhbC1jdXJzb3I.forged',
      bearerToken: tenant.apiKey,
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('cancelling', () => {
  it('cancels a queued notification', async () => {
    const tenant = await createTenant();
    const created = await createNotification(tenant, {});

    const cancelled = await request({
      method: 'POST',
      url: `/v1/notifications/${String(created.body.id)}/cancel`,
      bearerToken: tenant.apiKey,
    });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
  });

  it('records the cancellation on the timeline', async () => {
    const tenant = await createTenant();
    const created = await createNotification(tenant, {});
    await request({
      method: 'POST',
      url: `/v1/notifications/${String(created.body.id)}/cancel`,
      bearerToken: tenant.apiKey,
    });

    const events = await request({
      method: 'GET',
      url: `/v1/notifications/${String(created.body.id)}/events`,
      bearerToken: tenant.apiKey,
    });
    const eventTypes = (events.body.data as { eventType: string }[]).map(
      (event) => event.eventType,
    );

    expect(eventTypes).toContain('notification.cancelled');
  });

  it('refuses to cancel twice', async () => {
    const tenant = await createTenant();
    const created = await createNotification(tenant, {});
    await request({
      method: 'POST',
      url: `/v1/notifications/${String(created.body.id)}/cancel`,
      bearerToken: tenant.apiKey,
    });

    const second = await request({
      method: 'POST',
      url: `/v1/notifications/${String(created.body.id)}/cancel`,
      bearerToken: tenant.apiKey,
    });

    expect(second.statusCode).toBe(409);
  });

  it('cancels a scheduled notification before it is due', async () => {
    const tenant = await createTenant();
    const created = await createNotification(tenant, {
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const cancelled = await request({
      method: 'POST',
      url: `/v1/notifications/${String(created.body.id)}/cancel`,
      bearerToken: tenant.apiKey,
    });

    expect(cancelled.body.status).toBe('CANCELLED');
  });
});

describe('transactional enqueue through the API', () => {
  it('leaves a dispatch job behind for every accepted notification', async () => {
    const tenant = await createTenant();
    const created = await createNotification(tenant, {});

    const jobCount = await database.countDispatchJobs(String(created.body.id));

    // The property the whole design rests on, observed from the outside: the
    // notification and its job were written by the same transaction.
    expect(jobCount).toBe(1);
  });

  it('leaves no job behind for a rejected notification', async () => {
    const tenant = await createTenant();

    await createNotification(tenant, { recipient: 'not-a-number' });

    expect(await database.countAllDispatchJobs()).toBe(0);
  });
});
