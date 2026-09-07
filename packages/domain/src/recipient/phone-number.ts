/**
 * E.164: a leading plus, a country code that cannot start with zero, and at
 * most fifteen digits in total.
 */
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

const FORMATTING_CHARACTERS = /[\s()\-.]/g;

export class InvalidPhoneNumberError extends Error {
  public readonly value: string;

  public constructor(value: string) {
    super(
      'The recipient must be a phone number in international E.164 format, for example +5511999998888.',
    );
    this.name = 'InvalidPhoneNumberError';
    this.value = value;
  }
}

/**
 * Removes formatting a human would type, without guessing at a country.
 *
 * The API contract requires international format precisely because inferring a
 * country from a national number is a guess, and a guess here delivers the
 * message to a stranger.
 */
export function normalizePhoneNumber(value: string): string {
  const trimmed = value.trim().replaceAll(FORMATTING_CHARACTERS, '');

  if (trimmed.startsWith('00')) {
    return `+${trimmed.slice(2)}`;
  }
  return trimmed;
}

export function isValidPhoneNumber(value: string): boolean {
  return E164_PATTERN.test(value);
}

export function parsePhoneNumber(value: string): string {
  const normalized = normalizePhoneNumber(value);

  if (!isValidPhoneNumber(normalized)) {
    throw new InvalidPhoneNumberError(value);
  }
  return normalized;
}

/**
 * The provider's own chat identifier format. It is built here only for tests
 * and for display; the dispatch path always uses the identifier the provider
 * returns from its contact lookup, because national numbering rules — notably
 * the Brazilian ninth digit — make a locally constructed identifier unreliable.
 */
export function toProviderChatIdentifier(e164PhoneNumber: string): string {
  return `${e164PhoneNumber.replace('+', '')}@c.us`;
}

const VISIBLE_PREFIX_DIGITS = 2;
const VISIBLE_SUFFIX_DIGITS = 4;

/**
 * Keeps a number recognisable to an operator holding a support ticket while
 * removing enough digits that a log or an event payload is not a contact list.
 */
export function maskPhoneNumberForLog(phoneNumber: string): string {
  const digits = phoneNumber.replaceAll(/\D/g, '');

  if (digits.length <= VISIBLE_SUFFIX_DIGITS) {
    return '*'.repeat(digits.length);
  }

  const maskedLength = Math.max(0, digits.length - VISIBLE_PREFIX_DIGITS - VISIBLE_SUFFIX_DIGITS);

  return `+${digits.slice(0, VISIBLE_PREFIX_DIGITS)}${'*'.repeat(maskedLength)}${digits.slice(-VISIBLE_SUFFIX_DIGITS)}`;
}
