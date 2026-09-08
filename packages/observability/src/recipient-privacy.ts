import { createHash } from 'node:crypto';

/**
 * A stable, non-reversible identifier for a recipient. Log lines can be joined
 * on it without the phone number itself ever being written down.
 */
export function hashRecipient(phoneNumber: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${phoneNumber}`).digest('hex').slice(0, 12);
}
