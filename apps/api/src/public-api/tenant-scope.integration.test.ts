import {
  connectToTestDatabase,
  createRequestPathProbeRole,
  createTestConfiguration,
  type RequestPathProbeRole,
  type TestDatabaseHandle,
} from '@platform/testing';
import fastifyCookie from '@fastify/cookie';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { ApiModule } from '../api.module';
import { ProblemDetailsFilter } from '../http/filters/problem-details.filter';

/**
 * Proves the request path establishes tenant scope, rather than assuming it.
 *
 * The repositories filter every query by application id, so removing
 * `withTenantScope` from the five services that call it changed no answer and
 * broke no test. That mattered more than it looked: the row level security
 * policy only constrains `platform_tenant`, so the entire database layer is
 * conditional on the request path having entered that role. Without the
 * wrapper, a `/v1` request runs as the login role, which production grants full
 * DML on every table — and RLS is not a second line of defence at all.
 *
 * These tests serve `/v1` through a login role that holds no privileges on the
 * tables the scoped path needs. The request can only succeed if it assumed
 * `platform_tenant`, and — because the policy then applies — only if it also
 * set the application id. Deleting either statement from `withTenantScope`, or
 * dropping the wrapper from any one service, turns the matching test red.
 *
 * The database keeps its own tests in
 * packages/database/src/tenant-isolation.integration.test.ts. Nothing here
 * replaces them: that suite proves the policies work, this one proves the
 * request path reaches them.
 *
 * Two things to know before extending this file. `POST /v1/notifications` is
 * pinned twice, because the transactional enqueue runs on the request's own
 * connection and pg-boss's send privileges are granted to `platform_tenant`
 * alone. And `GET /ready` must not be asserted here: the queue check reads
 * `pgboss.queue` through the application pool, which this role has no USAGE on,
 * so it would fail for a reason that has nothing to do with tenant scope.
 */
const withheldTables = [
  'notifications',
  'notification_events',
  'idempotency_keys',
  'whatsapp_sessions',
];

interface JsonResponse {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

interface Tenant {
  readonly applicationId: string;
  readonly apiKey: string;
}

/** Registers tenants and issues keys. Connects as the owner, like every other suite. */
let setupApplication: NestFastifyApplication;
/** Serves `/v1` as the probe role. The subject of every assertion below. */
let scopedApplication: NestFastifyApplication;
let database: TestDatabaseHandle;
let probe: RequestPathProbeRole;
let tenantCounter = 0;

async function buildApplication(
  configuration: ReturnType<typeof createTestConfiguration>,
): Promise<NestFastifyApplication> {
  const moduleReference = await Test.createTestingModule({
    imports: [ApiModule.forConfiguration(configuration)],
  }).compile();

  const application = moduleReference.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await application.register(fastifyCookie);
  application.useGlobalFilters(
    new ProblemDetailsFilter(
      { error: () => undefined, info: () => undefined } as never,
      configuration.http.publicBaseUrl,
    ),
  );
  await application.init();
  await application.getHttpAdapter().getInstance().ready();

  return application;
}

beforeAll(async () => {
  const ownerConnectionUrl = inject('databaseUrl');
  database = connectToTestDatabase(ownerConnectionUrl);

  probe = await createRequestPathProbeRole({
    ownerConnectionUrl,
    roleName: 'tenant_scope_probe',
    password: 'tenant_scope_probe_password',
    withheldTables,
  });

  // One configuration, two pools. The API key pepper and the cursor signing key
  // are generated per call, so deriving rather than calling twice is what lets
  // a key minted by one instance authenticate against the other.
  const ownerConfiguration = createTestConfiguration(ownerConnectionUrl);
  const scopedConfiguration = {
    ...ownerConfiguration,
    database: { ...ownerConfiguration.database, applicationUrl: probe.connectionUrl },
  };

  setupApplication = await buildApplication(ownerConfiguration);
  scopedApplication = await buildApplication(scopedConfiguration);
}, 180_000);

afterAll(async () => {
  await probe.close();
  await scopedApplication.close();
  await setupApplication.close();
  await database.close();
});

beforeEach(async () => {
  await database.truncateAllTables();
});

async function scopedRequest(options: {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly apiKey: string;
  readonly payload?: unknown;
  readonly idempotencyKey?: string;
}): Promise<JsonResponse> {
  const response = await scopedApplication.inject({
    method: options.method,
    url: options.url,
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      ...(options.idempotencyKey !== undefined && { 'idempotency-key': options.idempotencyKey }),
    },
    payload: options.payload as never,
  });

  return {
    statusCode: response.statusCode,
    body: response.body.length > 0 ? response.json<Record<string, unknown>>() : {},
  };
}

async function createTenant(): Promise<Tenant> {
  tenantCounter += 1;
  const registered = await setupApplication.inject({
    method: 'POST',
    url: '/dashboard/auth/register',
    payload: {
      organizationName: `Scope tenant ${String(tenantCounter)}`,
      name: 'Owner',
      email: `scope-${String(tenantCounter)}@example.com`,
      password: 'a-long-enough-password',
    } as never,
  });
  const registeredBody = registered.json<Record<string, unknown>>();
  const rawCookie = registered.headers['set-cookie'];
  const cookie = String(Array.isArray(rawCookie) ? rawCookie[0] : rawCookie).split(';', 1)[0] ?? '';
  const headers = { cookie, 'x-csrf-token': registeredBody.csrfToken as string };

  const created = await setupApplication.inject({
    method: 'POST',
    url: '/dashboard/applications',
    headers,
    payload: { name: 'Store', slug: `store-${String(tenantCounter)}` } as never,
  });
  const applicationId = created.json<Record<string, unknown>>().id as string;

  const key = await setupApplication.inject({
    method: 'POST',
    url: `/dashboard/applications/${applicationId}/api-keys`,
    headers,
    payload: {
      name: 'backend',
      scopes: ['notifications:write', 'notifications:read'],
    } as never,
  });

  await database.insertWhatsAppSession(applicationId, `scope-session-${String(tenantCounter)}`);

  return {
    applicationId,
    apiKey: key.json<Record<string, unknown>>().plaintextKey as string,
  };
}

async function createNotification(tenant: Tenant, idempotencyKey?: string): Promise<JsonResponse> {
  return scopedRequest({
    method: 'POST',
    url: '/v1/notifications',
    apiKey: tenant.apiKey,
    payload: { recipient: '+5511999998888', body: 'Your order has shipped.' },
    ...(idempotencyKey !== undefined && { idempotencyKey }),
  });
}

/**
 * Without this the suite could pass while proving nothing: a role that happened
 * to hold the privileges anyway would serve every request whether or not the
 * scope was ever established.
 */
describe('the role the scoped requests run as', () => {
  it.each(withheldTables)('holds no privilege of any kind on %s', async (table) => {
    // Driven off the same array the role is built from, so a REVOKE that
    // stopped covering one table cannot leave a call site quietly unpinned
    // while every test stays green.
    expect(await probe.privilegesOn(table)).toStrictEqual({
      select: false,
      insert: false,
      update: false,
      delete: false,
    });
  });

  it('does not inherit the tenant role it is a member of', async () => {
    // The whole instrument rests on this. Were the membership inheriting, the
    // privileges would arrive without anyone calling SET ROLE and every
    // assertion below would pass against an unscoped request.
    expect(await probe.inheritsTenantRole()).toBe(false);
  });

  it.each(withheldTables)('is refused reading %s, and says why', async (table) => {
    let refusal: string | undefined;
    try {
      await probe.readWithoutScope(table);
    } catch (error: unknown) {
      // The driver's own message names the failed statement; the reason
      // Postgres gave is on the cause.
      refusal = (error as { cause?: { message?: string } }).cause?.message;
    }

    expect(refusal).toMatch(/permission denied/i);
  });

  it('is permitted the same read once it assumes the tenant role', async () => {
    // Only the privilege claim. That the scope also filters is proven below,
    // against rows two tenants actually own — asserting on an empty table here
    // would pass with the policy dropped.
    await expect(
      probe.readWithinScope('notifications', '00000000-0000-4000-8000-000000000000'),
    ).resolves.toStrictEqual([]);
  });
});

describe('a request that writes', () => {
  it('accepts a notification, which it could not do unscoped', async () => {
    const tenant = await createTenant();

    const response = await createNotification(tenant);

    expect(response.statusCode).toBe(202);
    expect(response.body.status).toBe('QUEUED');
  });

  it('writes a row that only the caller application can see', async () => {
    const tenant = await createTenant();
    const stranger = await createTenant();
    const created = await createNotification(tenant);
    const notificationId = created.body.id as string;

    // The insert passed the policy's WITH CHECK, so the application id was set
    // when it ran and it matched the row. Reading the same table under another
    // application's scope is what shows the row is genuinely bound to one
    // tenant rather than merely filtered out by a query predicate.
    const ownScope = await probe.readWithinScope('notifications', tenant.applicationId);
    const otherScope = await probe.readWithinScope('notifications', stranger.applicationId);

    expect(ownScope.map((row) => (row as { id: string }).id)).toContain(notificationId);
    expect(otherScope).toStrictEqual([]);
  });
});

describe('a request that claims an idempotency key', () => {
  it('accepts the first one', async () => {
    const tenant = await createTenant();

    // Without a key the service returns before the claim is ever made, so
    // withholding idempotency_keys would pin nothing at all.
    const response = await createNotification(tenant, 'scope-key-first');

    expect(response.statusCode).toBe(202);
  });

  it('replays the second, which reads the claim back as well as writing it', async () => {
    const tenant = await createTenant();
    const first = await createNotification(tenant, 'scope-key-replay');

    const second = await createNotification(tenant, 'scope-key-replay');

    expect(second.statusCode).toBe(202);
    expect(second.body.id).toBe(first.body.id);
  });
});

describe('a request that reads', () => {
  it('reads one notification back', async () => {
    const tenant = await createTenant();
    const created = await createNotification(tenant);

    const response = await scopedRequest({
      method: 'GET',
      url: `/v1/notifications/${String(created.body.id)}`,
      apiKey: tenant.apiKey,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.id).toBe(created.body.id);
  });

  it('lists them', async () => {
    const tenant = await createTenant();
    await createNotification(tenant);

    const response = await scopedRequest({
      method: 'GET',
      url: '/v1/notifications',
      apiKey: tenant.apiKey,
    });

    expect(response.statusCode).toBe(200);
    expect((response.body.data as unknown[]).length).toBe(1);
  });

  it('reads the timeline', async () => {
    const tenant = await createTenant();
    const created = await createNotification(tenant);

    const response = await scopedRequest({
      method: 'GET',
      url: `/v1/notifications/${String(created.body.id)}/events`,
      apiKey: tenant.apiKey,
    });

    expect(response.statusCode).toBe(200);
    expect((response.body.data as { eventType: string }[])[0]?.eventType).toBe(
      'notification.created',
    );
  });

  it('cancels one', async () => {
    const tenant = await createTenant();
    const created = await createNotification(tenant);

    const response = await scopedRequest({
      method: 'POST',
      url: `/v1/notifications/${String(created.body.id)}/cancel`,
      apiKey: tenant.apiKey,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('CANCELLED');
  });
});

describe('a request for another tenant', () => {
  it('is answered with a 404 while the database is enforcing isolation too', async () => {
    const owner = await createTenant();
    const stranger = await createTenant();
    const created = await createNotification(owner);

    const response = await scopedRequest({
      method: 'GET',
      url: `/v1/notifications/${String(created.body.id)}`,
      apiKey: stranger.apiKey,
    });

    // Both layers refuse it here: the repository filters by application id, and
    // the policy would return no row even if it did not.
    expect(response.statusCode).toBe(404);
  });
});
