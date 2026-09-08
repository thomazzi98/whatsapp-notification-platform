import { describe, expect, it } from 'vitest';

import { normalizeProviderMessageId } from './provider-message-id';

describe('normalizeProviderMessageId', () => {
  /**
   * The shapes observed against a real WhatsApp account. The send and the
   * acknowledgement disagree about the middle segment — one names the phone
   * number, the other the account's linked-device identifier — so only the
   * final segment can be compared, and this is the case that proves it.
   */
  it('reduces a send and its acknowledgement to the same identifier', () => {
    const fromSend = '3EB055173A81C4963B7466';
    const fromAcknowledgement = 'true_165515288932355@lid_3EB055173A81C4963B7466';

    expect(normalizeProviderMessageId(fromSend)).toBe(
      normalizeProviderMessageId(fromAcknowledgement),
    );
  });

  it('leaves a raw identifier alone', () => {
    expect(normalizeProviderMessageId('3EB055173A81C4963B7466')).toBe('3EB055173A81C4963B7466');
  });

  it('reads the identifier out of a serialized form', () => {
    expect(normalizeProviderMessageId('true_5511999998888@c.us_STUB000001')).toBe('STUB000001');
  });

  it('does not match two different messages to the same identifier', () => {
    const first = normalizeProviderMessageId('true_165515288932355@lid_AAAA1111');
    const second = normalizeProviderMessageId('true_165515288932355@lid_BBBB2222');

    expect(first).not.toBe(second);
  });

  it('returns the original when there is nothing after the separator', () => {
    // Rather than an empty string, which would match every other malformed
    // identifier and quietly attach a receipt to the wrong notification.
    expect(normalizeProviderMessageId('true_5511999998888@c.us_')).toBe('true_5511999998888@c.us_');
  });
});
