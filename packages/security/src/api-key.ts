import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  apiKeyDisplayPrefix,
  type ApiKeyEnvironment,
  apiKeyIdentifierLength,
  apiKeyLastFour,
  apiKeySecretLength,
  formatApiKey,
  type ParsedApiKey,
} from '@platform/domain';

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/**
 * The largest multiple of the alphabet size that fits in a byte. Bytes at or
 * above it are discarded rather than folded with a modulo, which would make the
 * first few characters of the alphabet measurably more likely and quietly
 * reduce the entropy of every key.
 */
const REJECTION_LIMIT = Math.floor(256 / TOKEN_ALPHABET.length) * TOKEN_ALPHABET.length;

function collectUsableCharacters(source: Buffer, wanted: number): string {
  let collected = '';

  for (const byte of source) {
    if (collected.length === wanted) {
      return collected;
    }
    if (byte < REJECTION_LIMIT) {
      collected += TOKEN_ALPHABET.charAt(byte % TOKEN_ALPHABET.length);
    }
  }

  return collected;
}

function randomAlphanumeric(length: number): string {
  let result = '';

  while (result.length < length) {
    result += collectUsableCharacters(randomBytes(length * 2), length - result.length);
  }

  return result;
}

export interface GeneratedApiKey {
  /** Shown to the operator exactly once, at creation. Never stored. */
  readonly token: string;
  readonly identifier: string;
  readonly displayPrefix: string;
  readonly lastFour: string;
  readonly keyHash: Buffer;
}

/**
 * HMAC-SHA256 under a pepper held outside the database.
 *
 * A slow key derivation function is the wrong tool here: the secret is 32
 * characters of CSPRNG output, so brute forcing it is infeasible regardless of
 * the hash, while a slow hash would add tens of milliseconds to every API
 * request and hand an attacker a cheap way to exhaust CPU. Using HMAC rather
 * than a bare digest means a database-only compromise — a leaked backup, an
 * injection — is useless without the pepper from the environment.
 */
export function hashApiKeySecret(secret: string, pepper: string): Buffer {
  return createHmac('sha256', Buffer.from(pepper, 'base64')).update(secret).digest();
}

export function isApiKeySecretValid(
  storedHash: Buffer,
  suppliedSecret: string,
  pepper: string,
): boolean {
  const suppliedHash = hashApiKeySecret(suppliedSecret, pepper);

  if (storedHash.length !== suppliedHash.length) {
    return false;
  }
  return timingSafeEqual(storedHash, suppliedHash);
}

export function generateApiKey(environment: ApiKeyEnvironment, pepper: string): GeneratedApiKey {
  const identifier = randomAlphanumeric(apiKeyIdentifierLength);
  const secret = randomAlphanumeric(apiKeySecretLength);

  return {
    token: formatApiKey(environment, identifier, secret),
    identifier,
    displayPrefix: apiKeyDisplayPrefix(environment, identifier),
    lastFour: apiKeyLastFour(secret),
    keyHash: hashApiKeySecret(secret, pepper),
  };
}

export function isParsedApiKeyValid(
  parsed: ParsedApiKey,
  storedHash: Buffer,
  pepper: string,
): boolean {
  return isApiKeySecretValid(storedHash, parsed.secret, pepper);
}
