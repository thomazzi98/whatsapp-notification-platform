import { describe, expect, it } from 'vitest';

import { hashRecipient, maskPhoneNumber } from './recipient-privacy';

const salt = 'a-test-salt';

describe('hashRecipient', () => {
  it('is stable for the same number and salt, so log lines can be joined', () => {
    expect(hashRecipient('+5511999998888', salt)).toBe(hashRecipient('+5511999998888', salt));
  });

  it('produces different values for different numbers', () => {
    expect(hashRecipient('+5511999998888', salt)).not.toBe(hashRecipient('+5511999998889', salt));
  });

  it('produces different values under a different salt, so hashes are not portable', () => {
    expect(hashRecipient('+5511999998888', salt)).not.toBe(
      hashRecipient('+5511999998888', 'another-salt'),
    );
  });

  it('never contains the original number', () => {
    const hashed = hashRecipient('+5511999998888', salt);

    expect(hashed).not.toContain('5511999998888');
    expect(hashed).toHaveLength(12);
  });
});

describe('maskPhoneNumber', () => {
  it('keeps a country prefix and the last four digits recognisable', () => {
    expect(maskPhoneNumber('+5511999998888')).toBe('+55*******8888');
  });

  it('ignores formatting characters', () => {
    expect(maskPhoneNumber('+55 (11) 99999-8888')).toBe('+55*******8888');
  });

  it('never reveals the middle digits', () => {
    const masked = maskPhoneNumber('+5511999998888');

    expect(masked).not.toContain('999998');
  });

  it('masks short numbers entirely rather than exposing most of them', () => {
    expect(maskPhoneNumber('1234')).toBe('****');
    expect(maskPhoneNumber('123')).toBe('***');
  });

  it('handles a number barely longer than the visible suffix', () => {
    expect(maskPhoneNumber('123456')).toBe('**3456');
  });
});
