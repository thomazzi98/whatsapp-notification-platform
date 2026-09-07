import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Derived from the session rather than stored.
 *
 * A token bound to the session identifier is valid for exactly that session and
 * needs no server-side state, so there is nothing to expire, clean up or get
 * out of sync with the session itself.
 */
export function deriveCsrfToken(sessionId: string, secret: string): string {
  return createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`csrf:${sessionId}`)
    .digest('base64url');
}

export function isCsrfTokenValid(supplied: string, expected: string): boolean {
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);

  if (suppliedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(suppliedBuffer, expectedBuffer);
}
