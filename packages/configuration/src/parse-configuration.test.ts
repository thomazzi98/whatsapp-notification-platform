import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ConfigurationError } from './configuration-error';
import { placeholderSecret } from './environment-schema';
import { parseConfiguration } from './parse-configuration';

function base64Key(): string {
  return randomBytes(32).toString('base64');
}

function validEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    HTTP_PUBLIC_BASE_URL: 'http://localhost:8080',
    DATABASE_APPLICATION_URL: 'postgres://application:secret@localhost:55432/notifications',
    DATABASE_SYSTEM_URL: 'postgres://system:secret@localhost:55432/notifications',
    WAHA_BASE_URL: 'http://waha:3000',
    WAHA_API_KEY: 'a-waha-api-key-value',
    WAHA_WEBHOOK_PUBLIC_URL: 'http://api:3000',
    SECURITY_API_KEY_PEPPER: base64Key(),
    SECURITY_ENCRYPTION_KEY: base64Key(),
    SECURITY_CURSOR_SIGNING_KEY: base64Key(),
    LOG_RECIPIENT_SALT: base64Key(),
    ...overrides,
  };
}

function productionEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return validEnvironment({
    NODE_ENV: 'production',
    SECURITY_COOKIE_SECURE: 'true',
    ...overrides,
  });
}

function issuesFrom(environment: Record<string, string | undefined>): string[] {
  try {
    parseConfiguration(environment);
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      return error.issues.map((issue) => issue.variableName);
    }
    throw error;
  }
  return [];
}

describe('parseConfiguration', () => {
  it('produces a grouped configuration object from a flat environment', () => {
    const configuration = parseConfiguration(validEnvironment());

    expect(configuration.nodeEnvironment).toBe('development');
    expect(configuration.http.publicBaseUrl).toBe('http://localhost:8080');
    expect(configuration.whatsAppProvider.baseUrl).toBe('http://waha:3000');
    expect(configuration.database.applicationUrl).toContain('postgres://');
  });

  it('applies documented defaults for optional variables', () => {
    const configuration = parseConfiguration(validEnvironment());

    expect(configuration.http.port).toBe(3000);
    expect(configuration.http.host).toBe('0.0.0.0');
    expect(configuration.queue.schema).toBe('pgboss');
    expect(configuration.queue.concurrency).toBe(5);
    expect(configuration.security.sessionCookieName).toBe('wnp_session');
    expect(configuration.observability.logLevel).toBe('info');
  });

  it('coerces numeric and boolean variables from their string form', () => {
    const configuration = parseConfiguration(
      validEnvironment({
        HTTP_PORT: '4100',
        QUEUE_CONCURRENCY: '12',
        SECURITY_REGISTRATION_ENABLED: 'false',
        SECURITY_COOKIE_SECURE: 'true',
      }),
    );

    expect(configuration.http.port).toBe(4100);
    expect(configuration.queue.concurrency).toBe(12);
    expect(configuration.security.registrationEnabled).toBe(false);
    expect(configuration.security.cookieSecure).toBe(true);
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const reported = issuesFrom({});

    expect(reported).toContain('HTTP_PUBLIC_BASE_URL');
    expect(reported).toContain('DATABASE_APPLICATION_URL');
    expect(reported).toContain('WAHA_API_KEY');
    expect(reported).toContain('SECURITY_API_KEY_PEPPER');
    expect(reported.length).toBeGreaterThan(4);
  });

  it('rejects a secret that is not exactly 32 bytes of base64', () => {
    expect(issuesFrom(validEnvironment({ SECURITY_API_KEY_PEPPER: 'too-short' }))).toContain(
      'SECURITY_API_KEY_PEPPER',
    );
    expect(
      issuesFrom({
        ...validEnvironment(),
        SECURITY_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64'),
      }),
    ).toContain('SECURITY_ENCRYPTION_KEY');
  });

  it('rejects a port outside the valid range', () => {
    expect(issuesFrom(validEnvironment({ HTTP_PORT: '70000' }))).toContain('HTTP_PORT');
    expect(issuesFrom(validEnvironment({ HTTP_PORT: '0' }))).toContain('HTTP_PORT');
  });

  it('rejects a database url that is not a postgres connection string', () => {
    expect(
      issuesFrom(validEnvironment({ DATABASE_APPLICATION_URL: 'mysql://localhost/db' })),
    ).toContain('DATABASE_APPLICATION_URL');
  });
});

describe('parseConfiguration in production', () => {
  it('accepts a correctly hardened production environment', () => {
    const configuration = parseConfiguration(productionEnvironment());

    expect(configuration.nodeEnvironment).toBe('production');
    expect(configuration.security.cookieSecure).toBe(true);
  });

  it('refuses to start with insecure session cookies', () => {
    expect(issuesFrom(productionEnvironment({ SECURITY_COOKIE_SECURE: 'false' }))).toContain(
      'SECURITY_COOKIE_SECURE',
    );
  });

  it('refuses to start when both database roles are the same, which disables row level security', () => {
    const sharedUrl = 'postgres://shared:secret@localhost:55432/notifications';

    expect(
      issuesFrom(
        productionEnvironment({
          DATABASE_APPLICATION_URL: sharedUrl,
          DATABASE_SYSTEM_URL: sharedUrl,
        }),
      ),
    ).toContain('DATABASE_SYSTEM_URL');
  });

  it('refuses to start while a secret still holds the example placeholder', () => {
    expect(issuesFrom(productionEnvironment({ WAHA_API_KEY: placeholderSecret }))).toContain(
      'WAHA_API_KEY',
    );
  });

  it('allows the same relaxed settings outside production', () => {
    const sharedUrl = 'postgres://shared:secret@localhost:55432/notifications';
    const configuration = parseConfiguration(
      validEnvironment({
        NODE_ENV: 'development',
        SECURITY_COOKIE_SECURE: 'false',
        DATABASE_APPLICATION_URL: sharedUrl,
        DATABASE_SYSTEM_URL: sharedUrl,
      }),
    );

    expect(configuration.security.cookieSecure).toBe(false);
  });
});
