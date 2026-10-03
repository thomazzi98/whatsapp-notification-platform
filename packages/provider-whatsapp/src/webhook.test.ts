import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  isWebhookSignatureValid,
  isWebhookTimestampAcceptable,
  parseWebhookEnvelope,
  toProviderEvent,
  toStoredPayload,
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

  it('reduces a serialized acknowledgement to the identifier the send stored', () => {
    // The engine addresses the acknowledgement by the account's linked device
    // and the send by the phone number, so the serialized strings differ. Only
    // the final segment matches, and matching is the whole point.
    const result = toProviderEvent(
      envelopeFor('message.ack', { id: 'true_165515288932355@lid_3EB055173A81C4963B7466', ack: 3 }),
    );

    expect(result).toMatchObject({ providerMessageId: '3EB055173A81C4963B7466' });
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
      accountLimits: { reachoutTimelock: null, newChatQuota: null },
    });
  });

  it('reads the restrictions a WORKING status is repeated with', () => {
    const result = toProviderEvent(
      envelopeFor('session.status', {
        name: 'wnp-1',
        status: 'WORKING',
        statuses: [],
        data: {
          reachoutTimelock: {
            isActive: true,
            timeEnforcementEnds: 1_791_000_000,
            enforcementType: 'WEB_COMPANION_ONLY',
          },
          messageCapping: {
            cappingStatus: 'FIRST_WARNING',
            totalQuota: 100,
            usedQuota: 80,
            cycleEnd: 1_793_000_000,
            mvStatus: null,
          },
        },
      }),
    );

    expect(result).toMatchObject({
      kind: 'session_status',
      accountLimits: {
        reachoutTimelock: {
          isActive: true,
          endsAt: new Date(1_791_000_000_000),
          enforcementType: 'WEB_COMPANION_ONLY',
        },
        newChatQuota: {
          status: 'FIRST_WARNING',
          total: 100,
          used: 80,
          cycleEndsAt: new Date(1_793_000_000_000),
        },
      },
    });
  });

  it('says nothing about the limits on a status other than WORKING', () => {
    // WAHA attaches restrictions to a WORKING status only, so any other one is
    // silence about them, not a report that nothing is in force.
    const starting = toProviderEvent(envelopeFor('session.status', { status: 'STARTING' }));
    const changed = toProviderEvent(envelopeFor('state.change', { status: 'WORKING' }));

    expect(starting).toMatchObject({ accountLimits: null });
    expect(changed).toMatchObject({ accountLimits: null });
  });

  it('keeps reading the status when the restriction data is malformed', () => {
    const result = toProviderEvent(
      envelopeFor('session.status', {
        status: 'WORKING',
        data: { reachoutTimelock: { isActive: 'sometimes' } },
      }),
    );

    expect(result).toMatchObject({
      kind: 'session_status',
      status: 'WORKING',
      accountLimits: { reachoutTimelock: null, newChatQuota: null },
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

describe('toStoredPayload', () => {
  it('keeps only what the platform reads from an acknowledgement', () => {
    // The WEBJS engine sends the whole message with each receipt, the text that
    // was sent included.
    const stored = toStoredPayload('message.ack', {
      id: 'true_5511999998888@c.us_3EB0',
      fromMe: true,
      ack: 2,
      ackName: 'DEVICE',
      body: 'Your verification code is 123456',
      _data: { notifyName: 'Someone' },
    });

    expect(stored).toStrictEqual({
      id: 'true_5511999998888@c.us_3EB0',
      fromMe: true,
      ack: 2,
      ackName: 'DEVICE',
    });
  });

  it('keeps other events as they came', () => {
    const payload = { name: 'wnp-1', status: 'WORKING', data: null };

    expect(toStoredPayload('session.status', payload)).toBe(payload);
  });
});
