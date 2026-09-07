import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_TOKEN_BYTES = 32;

export interface GeneratedSessionToken {
  /** Returned to the browser once, in a cookie. Never stored. */
  readonly token: string;
  readonly tokenHash: Buffer;
}

/**
 * Session tokens are 256 bits of CSPRNG output, so they have no guessable
 * structure and no dictionary to attack. A plain SHA-256 digest is therefore
 * the right way to store them: a slow password hash would add latency to every
 * authenticated request and buy nothing.
 */
export function generateSessionToken(): GeneratedSessionToken {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');

  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function isSessionTokenValid(storedHash: Buffer, suppliedToken: string): boolean {
  const suppliedHash = hashSessionToken(suppliedToken);

  if (storedHash.length !== suppliedHash.length) {
    return false;
  }
  return timingSafeEqual(storedHash, suppliedHash);
}
