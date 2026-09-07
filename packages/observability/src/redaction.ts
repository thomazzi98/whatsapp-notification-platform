/**
 * Paths pino replaces before anything reaches stdout.
 *
 * Two categories are covered. Credentials must never be logged at all. Message
 * content and recipient identity are customer personal data: they are visible
 * in the dashboard under tenant-scoped authorization, and deliberately not in
 * logs, where retention and access control are far weaker.
 */

/**
 * pino matches redaction paths literally: `password` covers a top-level
 * property and `*.password` covers one nested level, and neither implies the
 * other. Every sensitive name is therefore expanded into both forms.
 *
 * pino has no recursive wildcard, so a secret buried three levels deep would
 * still be printed. The mitigation is to log flat objects and to pass derived
 * values (recipientHash, recipientMasked) rather than raw payloads.
 */
const sensitivePropertyNames: readonly string[] = [
  'password',
  'passwordHash',
  'plaintextKey',
  'apiKey',
  'apiKeySecret',
  'secret',
  'pepper',
  'encryptionKey',
  'tokenHash',
  'sessionToken',
  'webhookHmacKey',
  'authorization',

  'qr',
  'qrCode',

  'recipient',
  'recipientPhoneNumber',
  'phoneNumber',
  'chatId',
  'renderedBody',
  'templateVariables',
  'text',
  'body',
];

const explicitHeaderPaths: readonly string[] = [
  'request.headers.authorization',
  'request.headers.cookie',
  'request.headers["x-api-key"]',
  'request.headers["x-webhook-hmac"]',
  'response.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-api-key"]',
];

export const redactedLogPaths: readonly string[] = [
  ...explicitHeaderPaths,
  ...sensitivePropertyNames.flatMap((propertyName) => [propertyName, `*.${propertyName}`]),
];

export const redactionCensorValue = '[redacted]';
