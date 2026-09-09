import { describe, expect, it } from 'vitest';

import {
  InvalidPhoneNumberError,
  isValidPhoneNumber,
  normalizePhoneNumber,
  parsePhoneNumber,
} from './phone-number';

describe('normalizePhoneNumber', () => {
  it('removes formatting a person would type', () => {
    expect(normalizePhoneNumber('+55 (11) 99999-8888')).toBe('+5511999998888');
    expect(normalizePhoneNumber('  +1 415 555 0132  ')).toBe('+14155550132');
    expect(normalizePhoneNumber('+44.20.7946.0958')).toBe('+442079460958');
  });

  it('converts an international dialling prefix to a plus', () => {
    expect(normalizePhoneNumber('005511999998888')).toBe('+5511999998888');
  });

  it('leaves an already normalized number untouched', () => {
    expect(normalizePhoneNumber('+5511999998888')).toBe('+5511999998888');
  });
});

describe('isValidPhoneNumber', () => {
  it('accepts well formed international numbers', () => {
    for (const value of ['+5511999998888', '+14155550132', '+442079460958', '+861234567890']) {
      expect(isValidPhoneNumber(value), value).toBe(true);
    }
  });

  it('rejects numbers without an international prefix', () => {
    for (const value of ['5511999998888', '11999998888', '0011999998888']) {
      expect(isValidPhoneNumber(value), value).toBe(false);
    }
  });

  it('rejects a country code starting with zero', () => {
    expect(isValidPhoneNumber('+0511999998888')).toBe(false);
  });

  it('rejects numbers that are too short or too long', () => {
    expect(isValidPhoneNumber('+1234567')).toBe(false);
    expect(isValidPhoneNumber('+1234567890123456')).toBe(false);
  });

  it('rejects values containing anything but digits', () => {
    for (const value of ['+55119999a8888', '+55 11 99999 8888', '']) {
      expect(isValidPhoneNumber(value), value).toBe(false);
    }
  });
});

describe('parsePhoneNumber', () => {
  it('normalizes then validates', () => {
    expect(parsePhoneNumber('+55 (11) 99999-8888')).toBe('+5511999998888');
  });

  it('throws a typed error carrying the original value', () => {
    let caught: InvalidPhoneNumberError | undefined;
    try {
      parsePhoneNumber('11999998888');
    } catch (error: unknown) {
      caught = error as InvalidPhoneNumberError;
    }

    expect(caught).toBeInstanceOf(InvalidPhoneNumberError);
    expect(caught?.value).toBe('11999998888');
    expect(caught?.message).toContain('E.164');
  });

  it('never guesses a country for a national number', () => {
    expect(() => parsePhoneNumber('(11) 99999-8888')).toThrow(InvalidPhoneNumberError);
  });
});
