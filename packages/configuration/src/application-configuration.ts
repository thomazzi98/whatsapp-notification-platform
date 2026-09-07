import { type ParsedEnvironment } from './environment-schema';

export interface HttpConfiguration {
  readonly port: number;
  readonly host: string;
  readonly publicBaseUrl: string;
  readonly bodyLimitBytes: number;
  readonly requestTimeoutMilliseconds: number;
}

export interface DatabaseConfiguration {
  readonly applicationUrl: string;
  readonly systemUrl: string;
  readonly maximumPoolSize: number;
  readonly statementTimeoutMilliseconds: number;
}

export interface QueueConfiguration {
  readonly schema: string;
  readonly concurrency: number;
  readonly pollingIntervalSeconds: number;
}

export interface WhatsAppProviderConfiguration {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly requestTimeoutMilliseconds: number;
  readonly webhookPublicUrl: string;
}

export interface SecurityConfiguration {
  readonly apiKeyPepper: string;
  readonly encryptionKey: string;
  readonly cursorSigningKey: string;
  readonly sessionCookieName: string;
  readonly sessionAbsoluteLifetimeSeconds: number;
  readonly sessionIdleLifetimeSeconds: number;
  readonly cookieSecure: boolean;
  readonly registrationEnabled: boolean;
}

export interface ObservabilityConfiguration {
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly logFormat: 'json' | 'pretty';
  readonly recipientSalt: string;
}

export interface ApplicationConfiguration {
  readonly nodeEnvironment: 'development' | 'test' | 'production';
  readonly http: HttpConfiguration;
  readonly database: DatabaseConfiguration;
  readonly queue: QueueConfiguration;
  readonly whatsAppProvider: WhatsAppProviderConfiguration;
  readonly security: SecurityConfiguration;
  readonly observability: ObservabilityConfiguration;
}

/**
 * The schema is flat because environment variables are flat; consumers get a
 * grouped object because that is pleasant to inject and to read.
 */
export function toApplicationConfiguration(
  environment: ParsedEnvironment,
): ApplicationConfiguration {
  return {
    nodeEnvironment: environment.NODE_ENV,
    http: {
      port: environment.HTTP_PORT,
      host: environment.HTTP_HOST,
      publicBaseUrl: environment.HTTP_PUBLIC_BASE_URL,
      bodyLimitBytes: environment.HTTP_BODY_LIMIT_BYTES,
      requestTimeoutMilliseconds: environment.HTTP_REQUEST_TIMEOUT_MILLISECONDS,
    },
    database: {
      applicationUrl: environment.DATABASE_APPLICATION_URL,
      systemUrl: environment.DATABASE_SYSTEM_URL,
      maximumPoolSize: environment.DATABASE_MAX_POOL_SIZE,
      statementTimeoutMilliseconds: environment.DATABASE_STATEMENT_TIMEOUT_MILLISECONDS,
    },
    queue: {
      schema: environment.QUEUE_SCHEMA,
      concurrency: environment.QUEUE_CONCURRENCY,
      pollingIntervalSeconds: environment.QUEUE_POLLING_INTERVAL_SECONDS,
    },
    whatsAppProvider: {
      baseUrl: environment.WAHA_BASE_URL,
      apiKey: environment.WAHA_API_KEY,
      requestTimeoutMilliseconds: environment.WAHA_REQUEST_TIMEOUT_MILLISECONDS,
      webhookPublicUrl: environment.WAHA_WEBHOOK_PUBLIC_URL,
    },
    security: {
      apiKeyPepper: environment.SECURITY_API_KEY_PEPPER,
      encryptionKey: environment.SECURITY_ENCRYPTION_KEY,
      cursorSigningKey: environment.SECURITY_CURSOR_SIGNING_KEY,
      sessionCookieName: environment.SECURITY_SESSION_COOKIE_NAME,
      sessionAbsoluteLifetimeSeconds: environment.SECURITY_SESSION_ABSOLUTE_LIFETIME_SECONDS,
      sessionIdleLifetimeSeconds: environment.SECURITY_SESSION_IDLE_LIFETIME_SECONDS,
      cookieSecure: environment.SECURITY_COOKIE_SECURE,
      registrationEnabled: environment.SECURITY_REGISTRATION_ENABLED,
    },
    observability: {
      logLevel: environment.LOG_LEVEL,
      logFormat: environment.LOG_FORMAT,
      recipientSalt: environment.LOG_RECIPIENT_SALT,
    },
  };
}
