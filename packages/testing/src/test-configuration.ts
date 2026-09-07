import { randomBytes } from 'node:crypto';

import { type ApplicationConfiguration } from '@platform/configuration';

const base64Key = (): string => randomBytes(32).toString('base64');

/**
 * A complete, valid configuration pointing at a disposable database. Secrets
 * are generated per run so a test can never accidentally depend on a fixed key.
 */
export function createTestConfiguration(
  connectionUrl: string,
  overrides: Partial<ApplicationConfiguration> = {},
): ApplicationConfiguration {
  return {
    nodeEnvironment: 'test',
    http: {
      port: 0,
      host: '127.0.0.1',
      publicBaseUrl: 'http://localhost:8080',
      bodyLimitBytes: 1_048_576,
      requestTimeoutMilliseconds: 30_000,
    },
    database: {
      applicationUrl: connectionUrl,
      systemUrl: connectionUrl,
      maximumPoolSize: 4,
      statementTimeoutMilliseconds: 5000,
    },
    queue: { schema: 'pgboss', concurrency: 2, pollingIntervalSeconds: 1 },
    whatsAppProvider: {
      baseUrl: 'http://waha.invalid:3000',
      apiKey: 'a-test-waha-api-key',
      requestTimeoutMilliseconds: 5000,

      webhookPublicUrl: 'http://api.invalid:3000',
    },
    security: {
      apiKeyPepper: base64Key(),
      encryptionKey: base64Key(),
      cursorSigningKey: base64Key(),
      sessionCookieName: 'wnp_session',
      sessionAbsoluteLifetimeSeconds: 2_592_000,
      sessionIdleLifetimeSeconds: 604_800,
      cookieSecure: false,
      registrationEnabled: true,
    },
    observability: { logLevel: 'error', logFormat: 'json', recipientSalt: base64Key() },
    ...overrides,
  };
}
