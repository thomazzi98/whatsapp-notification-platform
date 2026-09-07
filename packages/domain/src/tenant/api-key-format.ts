export const apiKeyEnvironments = ['live', 'test'] as const;

export type ApiKeyEnvironment = (typeof apiKeyEnvironments)[number];

export const apiKeyIdentifierLength = 12;
export const apiKeySecretLength = 32;

/**
 * The token is split into a public identifier and a secret.
 *
 * The identifier is stored in plain text and indexed, which is what makes
 * authentication a single indexed lookup. That in turn is why the secret can be
 * protected with a keyed hash rather than a per-row salted one: there is never
 * a need to scan candidate rows.
 */
export interface ParsedApiKey {
  readonly environment: ApiKeyEnvironment;
  readonly identifier: string;
  readonly secret: string;
}

const TOKEN_ALPHABET = /^[A-Za-z0-9]+$/;

export function apiKeyPrefix(environment: ApiKeyEnvironment): string {
  return `wnp_${environment}_`;
}

export function formatApiKey(
  environment: ApiKeyEnvironment,
  identifier: string,
  secret: string,
): string {
  return `${apiKeyPrefix(environment)}${identifier}${secret}`;
}

/**
 * The portion shown in listings. Enough to recognise a key at a glance, and
 * useless for authenticating.
 */
export function apiKeyDisplayPrefix(environment: ApiKeyEnvironment, identifier: string): string {
  return `${apiKeyPrefix(environment)}${identifier}`;
}

export function apiKeyLastFour(secret: string): string {
  return secret.slice(-4);
}

export class InvalidApiKeyFormatError extends Error {
  public constructor() {
    // The message never quotes the supplied value: an invalid token is still a
    // credential attempt, and echoing it risks writing it into a log.
    super('The API key is not in the expected format.');
    this.name = 'InvalidApiKeyFormatError';
  }
}

function toEnvironment(candidate: string): ApiKeyEnvironment | undefined {
  return (apiKeyEnvironments as readonly string[]).includes(candidate)
    ? (candidate as ApiKeyEnvironment)
    : undefined;
}

/**
 * Parses without touching the database, so a malformed token is rejected before
 * it costs a query. Returns undefined rather than throwing, because a bad token
 * is an expected condition on a public endpoint, not an exceptional one.
 */
export function tryParseApiKey(token: string): ParsedApiKey | undefined {
  const segments = token.split('_');
  if (segments.length !== 3) {
    return undefined;
  }

  const [namespace, environmentCandidate, body] = segments;
  if (namespace !== 'wnp' || environmentCandidate === undefined || body === undefined) {
    return undefined;
  }

  const environment = toEnvironment(environmentCandidate);
  if (environment === undefined) {
    return undefined;
  }
  if (body.length !== apiKeyIdentifierLength + apiKeySecretLength) {
    return undefined;
  }
  if (!TOKEN_ALPHABET.test(body)) {
    return undefined;
  }

  return {
    environment,
    identifier: body.slice(0, apiKeyIdentifierLength),
    secret: body.slice(apiKeyIdentifierLength),
  };
}

export function parseApiKey(token: string): ParsedApiKey {
  const parsed = tryParseApiKey(token);

  if (parsed === undefined) {
    throw new InvalidApiKeyFormatError();
  }
  return parsed;
}
