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
  // The names the configuration object actually uses. 'pepper' does not match
  // 'apiKeyPepper', which is how three secrets would have survived a single
  // logger.info({ configuration }).
  'apiKeyPepper',
  'encryptionKey',
  'cursorSigningKey',
  'recipientSalt',
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

/**
 * pino matches a path literally and has no recursive wildcard, so a secret two
 * levels down survives a name that is on the list. The configuration object is
 * the one shape where that matters: it is nested, it is whole, and logging it
 * is the obvious thing to do while debugging a boot problem.
 */
const configurationPaths: readonly string[] = [
  'configuration.security.apiKeyPepper',
  'configuration.security.encryptionKey',
  'configuration.security.cursorSigningKey',
  'configuration.observability.recipientSalt',
  'configuration.database.applicationUrl',
  'configuration.database.systemUrl',
  'configuration.whatsAppProvider.apiKey',
  '*.security.apiKeyPepper',
  '*.security.encryptionKey',
  '*.security.cursorSigningKey',
  '*.observability.recipientSalt',
  '*.database.applicationUrl',
  '*.database.systemUrl',
  '*.whatsAppProvider.apiKey',
];

export const redactedLogPaths: readonly string[] = [
  ...explicitHeaderPaths,
  ...configurationPaths,
  ...sensitivePropertyNames.flatMap((propertyName) => [propertyName, `*.${propertyName}`]),
];

export const redactionCensorValue = '[redacted]';
