import { authenticatedUserSchema } from '@platform/contracts';
import {
  connectToTestDatabase,
  createTestConfiguration,
  type TestDatabaseHandle,
} from '@platform/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import fastifyCookie from '@fastify/cookie';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { ApiModule } from '../api.module';
import { ProblemDetailsFilter } from '../http/filters/problem-details.filter';

interface JsonResponse {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
  readonly sessionCookie: string | undefined;
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
      // Errors are asserted through responses, so the logger stays silent.
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

  const response = await application.inject({
    method: options.method,
    url: options.url,
    headers,
    payload: options.payload as never,
  });

  const rawCookieHeader = response.headers['set-cookie'];
  const cookieHeader = Array.isArray(rawCookieHeader) ? rawCookieHeader[0] : rawCookieHeader;

  return {
    statusCode: response.statusCode,
    body: response.body.length > 0 ? response.json<Record<string, unknown>>() : {},
    sessionCookie: typeof cookieHeader === 'string' ? cookieHeader.split(';', 1)[0] : undefined,
  };
}

interface Tenant {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly applicationId: string;
}

async function registerTenant(email: string, organizationName: string): Promise<Tenant> {
  const registered = await request({
    method: 'POST',
    url: '/dashboard/auth/register',
    payload: { organizationName, name: 'Owner', email, password: 'a-long-enough-password' },
  });

  const cookie = registered.sessionCookie ?? '';
  const csrfToken = registered.body.csrfToken as string;

  const created = await request({
    method: 'POST',
    url: '/dashboard/applications',
    payload: { name: 'Store', slug: 'store' },
    cookie,
    csrfToken,
  });

  return { cookie, csrfToken, applicationId: created.body.id as string };
}

async function createKey(
  tenant: Tenant,
  scopes: string[],
): Promise<{ readonly id: string; readonly token: string }> {
  const created = await request({
    method: 'POST',
    url: `/dashboard/applications/${tenant.applicationId}/api-keys`,
    payload: { name: 'backend', scopes },
    cookie: tenant.cookie,
    csrfToken: tenant.csrfToken,
  });

  return { id: created.body.id as string, token: created.body.plaintextKey as string };
}

describe('registration and sign in', () => {
  it('creates an organization and returns a session', async () => {
    const response = await request({
      method: 'POST',
      url: '/dashboard/auth/register',
      payload: {
        organizationName: 'Acme',
        name: 'Rafael',
        email: 'rafael@example.com',
        password: 'a-long-enough-password',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.sessionCookie).toContain('wnp_session=');
    expect(response.body.csrfToken).toBeTypeOf('string');
  });

  it('returns a session that matches the published contract', async () => {
    const response = await request({
      method: 'POST',
      url: '/dashboard/auth/register',
      payload: {
        organizationName: 'Contract check',
        name: 'Rafael',
        email: 'contract-check@example.com',
        password: 'a-long-enough-password',
      },
    });

    // Parsed with the schema the dashboard is written against, rather than
    // spot-checked field by field. A response that merely looks right is how
    // the two sides came to disagree about the shape of a user in the first
    // place — the contract promised an organization object the API never sent.
    const parsed = authenticatedUserSchema.safeParse(response.body.user);

    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it('sets the session cookie as httpOnly with a lax same-site policy', async () => {
    const response = await application.inject({
      method: 'POST',
      url: '/dashboard/auth/register',
      payload: {
        organizationName: 'Acme',
        name: 'Rafael',
        email: 'rafael@example.com',
        password: 'a-long-enough-password',
      },
    });
    const rawCookieHeader = response.headers['set-cookie'];
    const cookie = Array.isArray(rawCookieHeader) ? rawCookieHeader[0] : String(rawCookieHeader);

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('rejects a second registration for the same email', async () => {
    const payload = {
      organizationName: 'Acme',
      name: 'Rafael',
      email: 'rafael@example.com',
      password: 'a-long-enough-password',
    };
    await request({ method: 'POST', url: '/dashboard/auth/register', payload });

    const second = await request({ method: 'POST', url: '/dashboard/auth/register', payload });

    expect(second.statusCode).toBe(409);
  });

  it('gives the same answer for a wrong password and an unknown address', async () => {
    // Distinguishing them turns the login form into an account enumeration
    // oracle.
    await request({
      method: 'POST',
      url: '/dashboard/auth/register',
      payload: {
        organizationName: 'Acme',
        name: 'Rafael',
        email: 'rafael@example.com',
        password: 'a-long-enough-password',
      },
    });

    const wrongPassword = await request({
      method: 'POST',
      url: '/dashboard/auth/login',
      payload: { email: 'rafael@example.com', password: 'not-the-password' },
    });
    const unknownEmail = await request({
      method: 'POST',
      url: '/dashboard/auth/login',
      payload: { email: 'nobody@example.com', password: 'not-the-password' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.body.detail).toBe(unknownEmail.body.detail);
  });

  it('rejects a password shorter than the documented minimum', async () => {
    const response = await request({
      method: 'POST',
      url: '/dashboard/auth/register',
      payload: {
        organizationName: 'Acme',
        name: 'Rafael',
        email: 'rafael@example.com',
        password: 'short',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses an unauthenticated request', async () => {
    const response = await request({ method: 'GET', url: '/dashboard/applications' });

    expect(response.statusCode).toBe(401);
  });
});

describe('cross-site request forgery protection', () => {
  it('refuses a state changing request without the token', async () => {
    const tenant = await registerTenant('a@example.com', 'Acme');

    const response = await request({
      method: 'POST',
      url: '/dashboard/applications',
      payload: { name: 'Another', slug: 'another' },
      cookie: tenant.cookie,
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a forged token', async () => {
    const tenant = await registerTenant('a@example.com', 'Acme');

    const response = await request({
      method: 'POST',
      url: '/dashboard/applications',
      payload: { name: 'Another', slug: 'another' },
      cookie: tenant.cookie,
      csrfToken: 'forged',
    });

    expect(response.statusCode).toBe(403);
  });

  it('allows a read without the token', async () => {
    const tenant = await registerTenant('a@example.com', 'Acme');

    const response = await request({
      method: 'GET',
      url: '/dashboard/applications',
      cookie: tenant.cookie,
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('tenant isolation', () => {
  it('hides another organization from every application route', async () => {
    const tenantA = await registerTenant('a@example.com', 'Acme');
    const tenantB = await registerTenant('b@example.com', 'Rival');

    const attempts = [
      await request({
        method: 'GET',
        url: `/dashboard/applications/${tenantA.applicationId}`,
        cookie: tenantB.cookie,
      }),
      await request({
        method: 'PATCH',
        url: `/dashboard/applications/${tenantA.applicationId}`,
        payload: { name: 'Hijacked' },
        cookie: tenantB.cookie,
        csrfToken: tenantB.csrfToken,
      }),
      await request({
        method: 'DELETE',
        url: `/dashboard/applications/${tenantA.applicationId}`,
        cookie: tenantB.cookie,
        csrfToken: tenantB.csrfToken,
      }),
      await request({
        method: 'GET',
        url: `/dashboard/applications/${tenantA.applicationId}/api-keys`,
        cookie: tenantB.cookie,
      }),
      await request({
        method: 'POST',
        url: `/dashboard/applications/${tenantA.applicationId}/api-keys`,
        payload: { name: 'stolen', scopes: ['notifications:read'] },
        cookie: tenantB.cookie,
        csrfToken: tenantB.csrfToken,
      }),
    ];

    // Not found rather than forbidden: the API must not confirm that an
    // identifier belonging to another tenant exists.
    expect(attempts.map((attempt) => attempt.statusCode)).toEqual([404, 404, 404, 404, 404]);
  });

  it('leaves the other tenant untouched after a failed attempt', async () => {
    const tenantA = await registerTenant('a@example.com', 'Acme');
    const tenantB = await registerTenant('b@example.com', 'Rival');

    await request({
      method: 'PATCH',
      url: `/dashboard/applications/${tenantA.applicationId}`,
      payload: { name: 'Hijacked' },
      cookie: tenantB.cookie,
      csrfToken: tenantB.csrfToken,
    });

    const stillThere = await request({
      method: 'GET',
      url: `/dashboard/applications/${tenantA.applicationId}`,
      cookie: tenantA.cookie,
    });

    expect(stillThere.body.name).toBe('Store');
  });

  it('lists only the caller own applications', async () => {
    await registerTenant('a@example.com', 'Acme');
    const tenantB = await registerTenant('b@example.com', 'Rival');

    const listed = await request({
      method: 'GET',
      url: '/dashboard/applications',
      cookie: tenantB.cookie,
    });

    expect((listed.body.data as unknown[]).length).toBe(1);
  });

  it('allows the same application slug in different organizations', async () => {
    await registerTenant('a@example.com', 'Acme');
    const tenantB = await registerTenant('b@example.com', 'Rival');

    expect(tenantB.applicationId).toBeTypeOf('string');
  });

  it('rejects a duplicate slug within one organization', async () => {
    const tenant = await registerTenant('a@example.com', 'Acme');

    const duplicate = await request({
      method: 'POST',
      url: '/dashboard/applications',
      payload: { name: 'Store again', slug: 'store' },
      cookie: tenant.cookie,
      csrfToken: tenant.csrfToken,
    });

    expect(duplicate.statusCode).toBe(409);
  });
});

describe('api keys', () => {
  it('returns the secret exactly once, at creation', async () => {
    const tenant = await registerTenant('a@example.com', 'Acme');
    const created = await createKey(tenant, ['notifications:read']);

    const listed = await request({
      method: 'GET',
      url: `/dashboard/applications/${tenant.applicationId}/api-keys`,
      cookie: tenant.cookie,
    });
    const keys = listed.body.data as Record<string, unknown>[];

    expect(created.token).toMatch(/^wnp_(live|test)_/);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toHaveProperty('plaintextKey');
    expect(JSON.stringify(keys)).not.toContain(created.token);
  });

  it('authenticates a request on the public API', async () => {
    const tenant = await registerTenant('a@example.com', 'Acme');
    const created = await createKey(tenant, ['notifications:read']);

    const response = await request({
      method: 'GET',
      url: '/v1/applications/current',
      bearerToken: created.token,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.id).toBe(tenant.applicationId);
  });

  it('refuses a key that lacks the required scope', async () => {
    const tenant = await registerTenant('a@example.com', 'Acme');
    const created = await createKey(tenant, ['notifications:write']);

    const response = await request({
      method: 'GET',
      url: '/v1/applications/current',
      bearerToken: created.token,
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a key whose expiry has passed', async () => {
    const tenant = await registerTenant('expiry@example.com', 'Acme');
    const created = await request({
      method: 'POST',
      url: `/dashboard/applications/${tenant.applicationId}/api-keys`,
      payload: {
        name: 'short-lived',
        scopes: ['notifications:read'],
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
      cookie: tenant.cookie,
      csrfToken: tenant.csrfToken,
    });

    const response = await request({
      method: 'GET',
      url: '/v1/applications/current',
      bearerToken: created.body.plaintextKey as string,
    });

    // The expiry is enforced in the authentication lookup's WHERE clause.
    // Nothing else exercises it, so removing that clause would let an expired
    // key keep working indefinitely.
    expect(created.statusCode).toBe(201);
    expect(response.statusCode).toBe(401);
  });

  it('accepts a key whose expiry is still ahead of it', async () => {
    const tenant = await registerTenant('future@example.com', 'Acme');
    const created = await request({
      method: 'POST',
      url: `/dashboard/applications/${tenant.applicationId}/api-keys`,
      payload: {
        name: 'long-lived',
        scopes: ['notifications:read'],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      cookie: tenant.cookie,
      csrfToken: tenant.csrfToken,
    });

    const response = await request({
      method: 'GET',
      url: '/v1/applications/current',
      bearerToken: created.body.plaintextKey as string,
    });

    // Without this, a clause that rejected every dated key would look correct.
    expect(response.statusCode).toBe(200);
  });

  it('refuses a revoked key immediately', async () => {
    const tenant = await registerTenant('a@example.com', 'Acme');
    const created = await createKey(tenant, ['notifications:read']);

    await request({
      method: 'DELETE',
      url: `/dashboard/applications/${tenant.applicationId}/api-keys/${created.id}`,
      cookie: tenant.cookie,
      csrfToken: tenant.csrfToken,
    });

    const response = await request({
      method: 'GET',
      url: '/v1/applications/current',
      bearerToken: created.token,
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses malformed and unknown tokens alike', async () => {
    const responses = [
      await request({ method: 'GET', url: '/v1/applications/current' }),
      await request({ method: 'GET', url: '/v1/applications/current', bearerToken: 'nonsense' }),
      await request({
        method: 'GET',
        url: '/v1/applications/current',
        bearerToken: `wnp_test_${'a'.repeat(44)}`,
      }),
    ];

    expect(responses.map((response) => response.statusCode)).toEqual([401, 401, 401]);
  });

  it('rejects a key with no scopes at creation', async () => {
    const tenant = await registerTenant('a@example.com', 'Acme');

    const response = await request({
      method: 'POST',
      url: `/dashboard/applications/${tenant.applicationId}/api-keys`,
      payload: { name: 'useless', scopes: [] },
      cookie: tenant.cookie,
      csrfToken: tenant.csrfToken,
    });

    expect(response.statusCode).toBe(400);
  });
});
