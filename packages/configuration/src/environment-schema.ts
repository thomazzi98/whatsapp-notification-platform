import { z } from 'zod';

/**
 * The schema is deliberately flat and keyed by the real environment variable
 * names. That keeps one source of truth: the same object validates the process
 * environment and generates `.env.example`, so documentation cannot drift from
 * what the application actually requires.
 */

const PLACEHOLDER_SECRET = 'replace-me-with-a-32-byte-base64-value';

function base64Key(byteLength: number): z.ZodType<string> {
  return z.string().refine((value) => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      return false;
    }
    return Buffer.from(value, 'base64').length === byteLength;
  }, `must be ${byteLength} bytes encoded as base64`);
}

function booleanFromString(defaultValue: 'true' | 'false'): z.ZodType<boolean, string | undefined> {
  return z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((value) => value === 'true');
}

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInteger = z.coerce.number().int().positive();

export const environmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development')
    .meta({ description: 'Runtime mode. Production enables the stricter safety checks.' }),

  HTTP_PORT: port.default(3000).meta({ description: 'Port the HTTP API listens on.' }),
  HTTP_HOST: z
    .string()
    .min(1)
    .default('0.0.0.0')
    .meta({ description: 'Interface the HTTP API binds to.' }),
  HTTP_PUBLIC_BASE_URL: z.url().meta({
    description: 'Base URL the dashboard and API documentation are reached on.',
    example: 'http://localhost:8080',
  }),
  HTTP_BODY_LIMIT_BYTES: positiveInteger
    .default(1_048_576)
    .meta({ description: 'Maximum accepted request body size.' }),
  HTTP_REQUEST_TIMEOUT_MILLISECONDS: positiveInteger
    .default(30_000)
    .meta({ description: 'Time an inbound request may take before it is aborted.' }),

  DATABASE_APPLICATION_URL: z.string().startsWith('postgres').meta({
    description:
      'Connection string for the tenant-scoped role. This role is subject to row level security.',
    example:
      'postgres://platform_application:platform_application_password@localhost:55432/notifications',
  }),
  DATABASE_SYSTEM_URL: z.string().startsWith('postgres').meta({
    description:
      'Connection string for the migration and maintenance role, which bypasses row level security.',
    example: 'postgres://platform_system:platform_system_password@localhost:55432/notifications',
  }),
  DATABASE_MAX_POOL_SIZE: positiveInteger
    .default(10)
    .meta({ description: 'Maximum connections held per pool.' }),
  DATABASE_STATEMENT_TIMEOUT_MILLISECONDS: positiveInteger
    .default(5000)
    .meta({ description: 'Server-side statement timeout for the application role.' }),

  QUEUE_SCHEMA: z
    .string()
    .min(1)
    .default('pgboss')
    .meta({ description: 'Postgres schema that holds the job queue tables.' }),
  QUEUE_CONCURRENCY: positiveInteger
    .default(5)
    .meta({ description: 'Jobs a single worker process handles concurrently.' }),
  QUEUE_POLLING_INTERVAL_SECONDS: positiveInteger
    .default(2)
    .meta({ description: 'How often a worker polls for newly available jobs.' }),

  WAHA_BASE_URL: z.url().meta({
    description: 'Base URL of the WAHA instance, reachable on the internal Docker network.',
    example: 'http://waha:3000',
  }),
  WAHA_API_KEY: z.string().min(16).meta({
    description: 'Value sent as the X-Api-Key header to WAHA.',
    example: PLACEHOLDER_SECRET,
  }),
  WAHA_REQUEST_TIMEOUT_MILLISECONDS: positiveInteger
    .default(30_000)
    .meta({ description: 'Time a single WAHA request may take before it is aborted.' }),
  WAHA_WEBHOOK_PUBLIC_URL: z.url().meta({
    description: 'Base URL WAHA calls back with delivery events. Must be reachable from WAHA.',
    example: 'http://api:3000',
  }),

  SECURITY_API_KEY_PEPPER: base64Key(32).meta({
    description:
      'Server-side pepper for API key hashing. Held outside the database so a dump alone cannot forge keys.',
    example: PLACEHOLDER_SECRET,
  }),
  SECURITY_ENCRYPTION_KEY: base64Key(32).meta({
    description: 'AES-256-GCM key protecting reversible secrets such as webhook signing keys.',
    example: PLACEHOLDER_SECRET,
  }),
  SECURITY_CURSOR_SIGNING_KEY: base64Key(32).meta({
    description: 'Signs pagination cursors so a tampered cursor is rejected rather than executed.',
    example: PLACEHOLDER_SECRET,
  }),
  SECURITY_SESSION_COOKIE_NAME: z
    .string()
    .min(1)
    .default('wnp_session')
    .meta({ description: 'Name of the dashboard session cookie.' }),
  SECURITY_SESSION_ABSOLUTE_LIFETIME_SECONDS: positiveInteger
    .default(2_592_000)
    .meta({ description: 'Hard session lifetime. Never extended, so a stolen session expires.' }),
  SECURITY_SESSION_IDLE_LIFETIME_SECONDS: positiveInteger
    .default(604_800)
    .meta({ description: 'Sliding idle timeout, extended on use.' }),
  SECURITY_COOKIE_SECURE: booleanFromString('false').meta({
    description: 'Send session cookies only over HTTPS. Required in production.',
  }),
  SECURITY_REGISTRATION_ENABLED: booleanFromString('true').meta({
    description: 'Allow new accounts to be created through the dashboard.',
  }),

  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info')
    .meta({ description: 'Minimum level written to stdout.' }),
  LOG_FORMAT: z
    .enum(['json', 'pretty'])
    .default('json')
    .meta({ description: 'Structured JSON for deployments, pretty for local development.' }),
  LOG_RECIPIENT_SALT: base64Key(32).meta({
    description:
      'Salt for hashing recipient phone numbers in logs, so delivery can be traced without storing personal data.',
    example: PLACEHOLDER_SECRET,
  }),
});

export type ParsedEnvironment = z.infer<typeof environmentSchema>;

export const placeholderSecret = PLACEHOLDER_SECRET;
