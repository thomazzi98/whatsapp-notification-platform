import { createHash } from 'node:crypto';

/**
 * A stable, non-reversible identifier for a recipient. Log lines can be joined
 * on it without the phone number itself ever being written down.
 */
export function hashRecipient(phoneNumber: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${phoneNumber}`).digest('hex').slice(0, 12);
}

const VISIBLE_PREFIX_LENGTH = 2;
const VISIBLE_SUFFIX_LENGTH = 4;

/**
 * Keeps a phone number recognisable to an operator holding a support ticket
 * while removing enough digits that the log is not a contact list.
 */
export function maskPhoneNumber(phoneNumber: string): string {
  const digits = phoneNumber.replaceAll(/\D/g, '');

  if (digits.length <= VISIBLE_SUFFIX_LENGTH) {
    return '*'.repeat(digits.length);
  }

  if (digits.length <= VISIBLE_PREFIX_LENGTH + VISIBLE_SUFFIX_LENGTH) {
    return `${'*'.repeat(digits.length - VISIBLE_SUFFIX_LENGTH)}${digits.slice(-VISIBLE_SUFFIX_LENGTH)}`;
  }

  const prefix = digits.slice(0, VISIBLE_PREFIX_LENGTH);
  const suffix = digits.slice(-VISIBLE_SUFFIX_LENGTH);
  const maskedLength = digits.length - VISIBLE_PREFIX_LENGTH - VISIBLE_SUFFIX_LENGTH;

  return `+${prefix}${'*'.repeat(maskedLength)}${suffix}`;
}
