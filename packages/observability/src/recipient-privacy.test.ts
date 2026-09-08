import { describe, expect, it } from 'vitest';

import { hashRecipient } from './recipient-privacy';

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
