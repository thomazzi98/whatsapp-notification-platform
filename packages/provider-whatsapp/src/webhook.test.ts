import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  isWebhookSignatureValid,
  isWebhookTimestampAcceptable,
  parseWebhookEnvelope,
  toProviderEvent,
} from './webhook';

const signingKey = 'a-shared-signing-key';

function sign(body: string, key = signingKey): string {
  return createHmac('sha512', key).update(body).digest('hex');
}

function envelopeFor(
  event: string,
  payload: Record<string, unknown>,
): {
  id: string;
  session: string;
  event: string;
  payload: Record<string, unknown>;
  me: null;
} {
  return { id: 'event-1', session: 'wnp-1', event, payload, me: null };
}

describe('isWebhookSignatureValid', () => {
  it('accepts a signature over the exact bytes that arrived', () => {
    const body = Buffer.from('{"id":"event-1","event":"message.ack"}');
    const isValid = isWebhookSignatureValid(body, sign(body.toString()), signingKey);

    expect(isValid).toBe(true);
  });

  it('rejects a body that was altered after signing', () => {
    const signature = sign('{"ack":2}');

    expect(isWebhookSignatureValid(Buffer.from('{"ack":3}'), signature, signingKey)).toBe(false);
  });

  it('rejects a signature made with a different key', () => {
    const body = Buffer.from('{"id":"event-1"}');
    const otherSignature = sign(body.toString(), 'another-tenants-key');

    expect(isWebhookSignatureValid(body, otherSignature, signingKey)).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // A constant-time comparison requires equal lengths, so this has to be
    // handled before the comparison rather than by it.
    expect(isWebhookSignatureValid(Buffer.from('{}'), 'short', signingKey)).toBe(false);
  });

  it('is sensitive to key order, which is why the raw bytes are kept', () => {
    const asSent = '{"id":"event-1","event":"message.ack"}';
    const reSerialised = JSON.stringify(JSON.parse(asSent));
    const reordered = '{"event":"message.ack","id":"event-1"}';

    expect(isWebhookSignatureValid(Buffer.from(reSerialised), sign(asSent), signingKey)).toBe(true);
    expect(isWebhookSignatureValid(Buffer.from(reordered), sign(asSent), signingKey)).toBe(false);
  });
});

describe('isWebhookTimestampAcceptable', () => {
  const now = new Date('2026-09-08T00:00:00.000Z');
  const nowMilliseconds = now.getTime();

  it('accepts a recent callback', () => {
    const recent = String(nowMilliseconds - 30_000);

    expect(isWebhookTimestampAcceptable(recent, now, 300)).toBe(true);
  });

  it('rejects a callback captured and replayed later', () => {
    const anHourAgo = String(nowMilliseconds - 3_600_000);

    expect(isWebhookTimestampAcceptable(anHourAgo, now, 300)).toBe(false);
  });

  it('rejects a timestamp from the future beyond the tolerance', () => {
    const anHourAhead = String(nowMilliseconds + 3_600_000);

    expect(isWebhookTimestampAcceptable(anHourAhead, now, 300)).toBe(false);
  });

  it('accepts a timestamp expressed in seconds', () => {
    const inSeconds = String(Math.floor(nowMilliseconds / 1000));

    expect(isWebhookTimestampAcceptable(inSeconds, now, 300)).toBe(true);
  });

  it('accepts a callback that carries no timestamp', () => {
    // The inbox already rejects a repeated event identifier, so a provider that
    // omits the header is not left unable to deliver anything.
    expect(isWebhookTimestampAcceptable(undefined, now, 300)).toBe(true);
  });

  it('rejects a timestamp that is not a number', () => {
    expect(isWebhookTimestampAcceptable('yesterday', now, 300)).toBe(false);
  });
});

describe('parseWebhookEnvelope', () => {
  it('reads an envelope that carries the fields the platform acts on', () => {
    const envelope = parseWebhookEnvelope({
      id: 'event-1',
      session: 'wnp-1',
      event: 'message.ack',
      payload: { id: 'message-1', ack: 2 },
    });

    expect(envelope?.id).toBe('event-1');
  });

  it('accepts an envelope carrying fields this version does not know', () => {
    // A provider upgrade that adds keys must not stop delivery receipts from
    // being ingested.
    const envelope = parseWebhookEnvelope({
      id: 'event-1',
      session: 'wnp-1',
      event: 'message.ack',
      payload: {},
      somethingNew: { nested: true },
    });

    expect(envelope).toBeDefined();
  });

  it('rejects a body that is not an envelope at all', () => {
    expect(parseWebhookEnvelope({ hello: 'world' })).toBeUndefined();
    expect(parseWebhookEnvelope(undefined)).toBeUndefined();
  });
});

describe('toProviderEvent', () => {
  it('translates a delivery acknowledgement', () => {
    const result = toProviderEvent(envelopeFor('message.ack', { id: 'message-1', ack: 2 }));

    expect(result).toEqual({
      kind: 'message_acknowledgement',
      providerMessageId: 'message-1',
      acknowledgement: 2,
      fromUs: true,
    });
  });

  it('marks an inbound message so it is not matched against a notification', () => {
    const result = toProviderEvent(
      envelopeFor('message.ack', { id: 'message-1', ack: 2, fromMe: false }),
    );

    expect(result).toMatchObject({ kind: 'message_acknowledgement', fromUs: false });
  });

  it('refuses an acknowledgement value the platform does not recognise', () => {
    const result = toProviderEvent(envelopeFor('message.ack', { id: 'message-1', ack: 99 }));

    expect(result).toEqual({ kind: 'unsupported', eventType: 'message.ack' });
  });

  it('translates a session status change', () => {
    const envelope = envelopeFor('session.status', { name: 'wnp-1', status: 'WORKING' });
    const result = toProviderEvent({
      ...envelope,
      me: { id: '5511999990000@c.us', pushName: 'Storefront' },
    });

    expect(result).toEqual({
      kind: 'session_status',
      sessionName: 'wnp-1',
      status: 'WORKING',
      phoneNumber: '+5511999990000',
      pushName: 'Storefront',
    });
  });

  it('reads a status the platform does not know as UNKNOWN rather than failing', () => {
    const result = toProviderEvent(envelopeFor('session.status', { status: 'PASSKEY_PENDING' }));

    expect(result).toMatchObject({ kind: 'session_status', status: 'UNKNOWN' });
  });

  it('reports an event type it has no rule for', () => {
    const result = toProviderEvent(envelopeFor('message.reaction', {}));

    expect(result).toEqual({ kind: 'unsupported', eventType: 'message.reaction' });
  });
});
