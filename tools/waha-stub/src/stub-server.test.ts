import { type AddressInfo, createServer } from 'node:net';

import { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStubServer } from './create-stub-server';
import { MAXIMUM_QR_ATTEMPTS } from './session-store';
import { signPayload } from './webhook-sender';

const apiKey = 'test-stub-key';
let server: FastifyInstance;

beforeEach(async () => {
  server = createStubServer({ apiKey });
  await server.ready();
});

afterEach(async () => {
  await server.close();
});

async function call(options: {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly url: string;
  readonly payload?: unknown;
  readonly withApiKey?: boolean;
}): Promise<{
  statusCode: number;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
}> {
  const response = await server.inject({
    method: options.method,
    url: options.url,
    headers: options.withApiKey === false ? {} : { 'x-api-key': apiKey },
    payload: options.payload as never,
  });

  return {
    statusCode: response.statusCode,
    body: response.body.length > 0 ? response.json<Record<string, unknown>>() : {},
    headers: response.headers,
  };
}

/**
 * A receiver that refuses at once. An unresolvable name waits on the resolver
 * instead -- eleven seconds on one machine -- which timed this suite out there
 * and nowhere else.
 */
async function unreachableReceiver(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });

  return `http://127.0.0.1:${String(port)}/webhooks`;
}

async function createWorkingSession(name = 'default'): Promise<void> {
  await call({ method: 'POST', url: '/api/sessions', payload: { name, start: true } });
  await call({ method: 'POST', url: `/__stub/sessions/${name}/scan`, payload: {} });
}

describe('authentication', () => {
  it('leaves the liveness probe unauthenticated, matching the real server', async () => {
    const response = await call({ method: 'GET', url: '/ping', withApiKey: false });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ message: 'pong' });
  });

  it('rejects an API request without the key', async () => {
    const response = await call({ method: 'GET', url: '/api/sessions', withApiKey: false });

    expect(response.statusCode).toBe(401);
  });
});

describe('session lifecycle', () => {
  it('creates a session that waits for a QR code', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'default', start: true },
    });

    expect(created.statusCode).toBe(201);
    expect(created.body.status).toBe('SCAN_QR_CODE');
  });

  it('rejects creating the same session twice', async () => {
    await call({ method: 'POST', url: '/api/sessions', payload: { name: 'default' } });
    const second = await call({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'default' },
    });

    expect(second.statusCode).toBe(422);
  });

  it('reaches WORKING once the code is scanned', async () => {
    await createWorkingSession();
    const status = await call({ method: 'GET', url: '/api/sessions/default' });

    expect(status.body.status).toBe('WORKING');
    expect(status.body.me).toMatchObject({ pushName: 'Stub Account' });
  });

  it('reports no identity before the session is paired', async () => {
    await call({ method: 'POST', url: '/api/sessions', payload: { name: 'default', start: true } });

    const response = await server.inject({
      method: 'GET',
      url: '/api/sessions/default/me',
      headers: { 'x-api-key': apiKey },
    });

    // Null rather than an empty object, matching the real provider, so the
    // adapter's parsing is exercised against the shape it will actually meet.
    expect(response.json()).toBeNull();
  });

  it('restarts straight to WORKING once credentials exist, without a new code', async () => {
    await createWorkingSession();
    await call({ method: 'POST', url: '/api/sessions/default/stop' });
    const restarted = await call({ method: 'POST', url: '/api/sessions/default/restart' });

    expect(restarted.body.status).toBe('WORKING');
  });

  it('requires a new code after logging out, because credentials are gone', async () => {
    await createWorkingSession();
    await call({ method: 'POST', url: '/api/sessions/default/logout' });
    const restarted = await call({ method: 'POST', url: '/api/sessions/default/start' });

    expect(restarted.body.status).toBe('SCAN_QR_CODE');
  });
});

describe('QR codes', () => {
  it('serves a base64 image by default and a raw value on request', async () => {
    await call({ method: 'POST', url: '/api/sessions', payload: { name: 'default', start: true } });

    const image = await call({ method: 'GET', url: '/api/default/auth/qr' });
    const raw = await call({ method: 'GET', url: '/api/default/auth/qr?format=raw' });

    expect(image.body.mimetype).toBe('image/png');
    expect(image.body.data).toBeTypeOf('string');
    expect(raw.body.value).toBeTypeOf('string');
  });

  it('serves something a browser can actually draw', async () => {
    await call({ method: 'POST', url: '/api/sessions', payload: { name: 'default', start: true } });

    const image = await call({ method: 'GET', url: '/api/default/auth/qr' });
    const decoded = Buffer.from(String(image.body.data), 'base64');

    // Claiming image/png and returning the pairing string satisfies every
    // assertion above and renders as a broken image in the dashboard.
    expect([...decoded.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(decoded.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(decoded.readUInt32BE(16)).toBeGreaterThan(0);
  });

  it('draws a different code for a different session', async () => {
    await call({ method: 'POST', url: '/api/sessions', payload: { name: 'default', start: true } });
    await call({ method: 'POST', url: '/api/sessions', payload: { name: 'second', start: true } });

    const first = await call({ method: 'GET', url: '/api/default/auth/qr' });
    const second = await call({ method: 'GET', url: '/api/second/auth/qr' });

    expect(first.body.data).not.toBe(second.body.data);
  });

  it('ignores start on a session whose codes ran out, as the real engine does', async () => {
    await call({ method: 'POST', url: '/api/sessions', payload: { name: 'default', start: true } });
    for (let attempt = 0; attempt < MAXIMUM_QR_ATTEMPTS; attempt += 1) {
      await call({ method: 'POST', url: '/__stub/sessions/default/expire-qr' });
    }

    const started = await call({ method: 'POST', url: '/api/sessions/default/start' });

    // Observed against noweb-2026.8.2 on 2026-09-23. Starting it anyway is what
    // made the stub hide a dashboard that could not recover from a slow scan.
    expect(started.body.status).toBe('FAILED');
  });

  it('refuses to serve a code when the session is not waiting for one', async () => {
    await createWorkingSession();
    const response = await call({ method: 'GET', url: '/api/default/auth/qr' });

    expect(response.statusCode).toBe(422);
  });

  it('fails the session once the code budget is exhausted', async () => {
    await call({ method: 'POST', url: '/api/sessions', payload: { name: 'default', start: true } });

    for (let attempt = 1; attempt < MAXIMUM_QR_ATTEMPTS; attempt += 1) {
      const expired = await call({ method: 'POST', url: '/__stub/sessions/default/expire-qr' });
      expect(expired.body.status).toBe('SCAN_QR_CODE');
    }

    const final = await call({ method: 'POST', url: '/__stub/sessions/default/expire-qr' });

    // Mirrors the real limit: after the sixth unscanned code the session stops
    // and the operator has to restart it.
    expect(final.body.status).toBe('FAILED');
  });
});

describe('sending messages', () => {
  it('answers with a nested identifier, as the WEBJS engine does', async () => {
    await createWorkingSession();

    const sent = await call({
      method: 'POST',
      url: '/api/sendText',
      payload: { session: 'default', chatId: '5511999998888@c.us', text: 'Hello' },
    });
    const identifier = sent.body.id as { id?: string; _serialized?: string; fromMe?: boolean };

    expect(sent.statusCode).toBe(200);
    expect(identifier.fromMe).toBe(true);
    expect(identifier.id).toBeTypeOf('string');
    // The serialized form names the chat the message went to, which is not
    // what the acknowledgement will name.
    expect(identifier._serialized).toBe(`true_5511999998888@c.us_${identifier.id ?? ''}`);
  });

  it('acknowledges by the linked device, not by the number it sent to', async () => {
    // A webhook has to be configured for a delivery to be recorded at all; the
    // receiver is unreachable on purpose, and a failed delivery is still an
    // envelope this test can read.
    await call({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        name: 'default',
        start: true,
        config: {
          webhooks: [{ url: await unreachableReceiver(), events: ['message.ack'] }],
        },
      },
    });
    await call({ method: 'POST', url: '/__stub/sessions/default/scan', payload: {} });
    const sent = await call({
      method: 'POST',
      url: '/api/sendText',
      payload: { session: 'default', chatId: '5511999998888@c.us', text: 'Hello' },
    });
    const messageIdentifier = (sent.body.id as { id: string }).id;

    await call({
      method: 'POST',
      url: '/__stub/sessions/default/acknowledge',
      payload: { messageId: messageIdentifier, ack: 2 },
    });

    // The addresses differ between the send and the receipt, exactly as they do
    // against a real account. Anything comparing the serialized strings would
    // pass against a stub that used one address for both, and fail in
    // production.
    const delivered = await call({ method: 'GET', url: '/__stub/webhooks' });
    const deliveries = delivered.body.deliveries as {
      envelope: { event: string; payload: { id: string } };
    }[];
    const acknowledgement = deliveries.find((entry) => entry.envelope.event === 'message.ack');

    expect(acknowledgement?.envelope.payload.id).toBe(
      `true_165515288932355@lid_${messageIdentifier}`,
    );
    expect(acknowledgement?.envelope.payload.id).not.toContain('5511999998888');
  });

  it('refuses to send while the session is not connected', async () => {
    await call({ method: 'POST', url: '/api/sessions', payload: { name: 'default', start: true } });

    const sent = await call({
      method: 'POST',
      url: '/api/sendText',
      payload: { session: 'default', chatId: '5511999998888@c.us', text: 'Hello' },
    });

    expect(sent.statusCode).toBe(422);
  });

  it('selects a failure from the recipient number, so a test needs no setup', async () => {
    await createWorkingSession();

    const serverError = await call({
      method: 'POST',
      url: '/api/sendText',
      payload: { session: 'default', chatId: '5511999990500@c.us', text: 'Hello' },
    });
    const unauthorized = await call({
      method: 'POST',
      url: '/api/sendText',
      payload: { session: 'default', chatId: '5511999990401@c.us', text: 'Hello' },
    });
    const rateLimited = await call({
      method: 'POST',
      url: '/api/sendText',
      payload: { session: 'default', chatId: '5511999990429@c.us', text: 'Hello' },
    });

    expect(serverError.statusCode).toBe(500);
    expect(unauthorized.statusCode).toBe(401);
    expect(rateLimited.statusCode).toBe(429);
    // Without this the caller cannot tell a provider that named a wait from one
    // that did not, and the backoff it computes is its own guess either way.
    expect(rateLimited.headers['retry-after']).toBe('90');
  });

  it('can be forced into a failure mode for any recipient', async () => {
    await createWorkingSession();
    await call({ method: 'POST', url: '/__stub/failure-mode', payload: { mode: 'server_error' } });

    const sent = await call({
      method: 'POST',
      url: '/api/sendText',
      payload: { session: 'default', chatId: '5511999998888@c.us', text: 'Hello' },
    });

    expect(sent.statusCode).toBe(500);
  });

  it('rejects an unknown failure mode rather than silently ignoring it', async () => {
    const response = await call({
      method: 'POST',
      url: '/__stub/failure-mode',
      payload: { mode: 'explode' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('recipient lookup', () => {
  it('returns the provider chat identifier for a registered number', async () => {
    const response = await call({
      method: 'GET',
      url: '/api/contacts/check-exists?phone=5511999998888&session=default',
    });

    expect(response.body).toEqual({ numberExists: true, chatId: '5511999998888@c.us' });
  });

  it('reports a designated number as not registered on WhatsApp', async () => {
    const response = await call({
      method: 'GET',
      url: '/api/contacts/check-exists?phone=5511999990404&session=default',
    });

    expect(response.body.numberExists).toBe(false);
  });
});

describe('webhook signing', () => {
  it('signs the exact bytes that are sent', () => {
    const rawBody = JSON.stringify({ event: 'message.ack', payload: { ack: 3 } });
    const key = 'a-signing-key';

    expect(signPayload(rawBody, key)).toBe(signPayload(rawBody, key));
    expect(signPayload(rawBody, key)).not.toBe(signPayload(rawBody, 'another-key'));
  });

  it('produces a different signature if a single byte changes', () => {
    const key = 'a-signing-key';

    expect(signPayload('{"a":1}', key)).not.toBe(signPayload('{"a":2}', key));
  });

  it('would fail if the receiver re-serialised the body', () => {
    // The reason the receiver must verify against the raw bytes. Formatting
    // that JSON treats as insignificant is not insignificant to a digest, so a
    // handler that parses first and re-serialises computes a different one.
    const original = '{"event": "message.ack", "payload": {"ack": 3}}';
    const reserialised = JSON.stringify(JSON.parse(original) as unknown);

    expect(reserialised).not.toBe(original);
    expect(signPayload(original, 'key')).not.toBe(signPayload(reserialised, 'key'));
  });
});

describe('answering as another engine', () => {
  it('can answer a send as NOWEB does, with a key and no serialized form', async () => {
    await createWorkingSession();
    await call({ method: 'POST', url: '/__stub/engine', payload: { engine: 'NOWEB' } });

    const sent = await call({
      method: 'POST',
      url: '/api/sendText',
      payload: { session: 'default', chatId: '5511999998888@c.us', text: 'Hello' },
    });

    expect((sent.body.key as { id?: string }).id).toBeTypeOf('string');
    expect(JSON.stringify(sent.body)).not.toContain('true_');
  });

  it('rejects an engine it cannot imitate', async () => {
    const response = await call({
      method: 'POST',
      url: '/__stub/engine',
      payload: { engine: 'VENOM' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('restrictions WhatsApp places on the account', () => {
  it('reports no timelock and no cap on an account nothing has happened to', async () => {
    await createWorkingSession();

    const timelock = await call({ method: 'GET', url: '/api/sessions/default/timelock' });
    const capping = await call({ method: 'GET', url: '/api/sessions/default/capping' });

    expect(timelock.body).toMatchObject({ isActive: false, timeEnforcementEnds: null });
    expect(capping.body).toMatchObject({ cappingStatus: 'NONE', totalQuota: -1 });
  });

  it('serves a timelock it was told about, live and with the session', async () => {
    await createWorkingSession();
    await call({
      method: 'POST',
      url: '/__stub/sessions/default/restrict',
      payload: { timelockMinutes: 90 },
    });

    const timelock = await call({ method: 'GET', url: '/api/sessions/default/timelock' });
    const session = await call({ method: 'GET', url: '/api/sessions/default' });

    expect(timelock.body.isActive).toBe(true);
    expect(timelock.body.timeEnforcementEnds).toBeTypeOf('number');
    expect((session.body.me as { reachoutTimelock?: unknown }).reachoutTimelock).toStrictEqual(
      timelock.body,
    );
  });

  it('repeats the status with the restriction in force when it changes', async () => {
    await call({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        name: 'default',
        start: true,
        config: {
          webhooks: [{ url: await unreachableReceiver(), events: ['session.status'] }],
        },
      },
    });
    await call({ method: 'POST', url: '/__stub/sessions/default/scan', payload: {} });
    await call({
      method: 'POST',
      url: '/__stub/sessions/default/restrict',
      payload: {
        timelockMinutes: 30,
        cappingStatus: 'FIRST_WARNING',
        usedQuota: 80,
        totalQuota: 100,
      },
    });

    const delivered = await call({ method: 'GET', url: '/__stub/webhooks' });
    const deliveries = delivered.body.deliveries as {
      envelope: {
        event: string;
        payload: { status: string; data: Record<string, unknown> | null };
      };
    }[];
    const latest = deliveries.findLast((entry) => entry.envelope.event === 'session.status');

    expect(latest?.envelope.payload.status).toBe('WORKING');
    expect(latest?.envelope.payload.data).toMatchObject({
      reachoutTimelock: { isActive: true },
      messageCapping: { cappingStatus: 'FIRST_WARNING', usedQuota: 80, totalQuota: 100 },
    });
  });

  it('answers the live lookups as an engine that cannot read them, when told to', async () => {
    await createWorkingSession();
    await call({
      method: 'POST',
      url: '/__stub/sessions/default/restrict',
      payload: { lookupUnavailable: true },
    });

    const timelock = await call({ method: 'GET', url: '/api/sessions/default/timelock' });
    const capping = await call({ method: 'GET', url: '/api/sessions/default/capping' });

    expect(timelock.statusCode).toBe(501);
    expect(capping.statusCode).toBe(501);
  });

  it('refuses a message to a designated number as WhatsApp refuses a new contact', async () => {
    await createWorkingSession();

    const sent = await call({
      method: 'POST',
      url: '/api/sendText',
      payload: { session: 'default', chatId: '5511999990463@c.us', text: 'Hello' },
    });
    const timelock = await call({ method: 'GET', url: '/api/sessions/default/timelock' });

    expect(sent.statusCode).toBe(500);
    expect(JSON.stringify(sent.body)).toContain('server returned error 463');
    expect(timelock.body.isActive).toBe(true);
  });

  it('refuses a message once the quota is used up, and says so', async () => {
    await createWorkingSession();

    const sent = await call({
      method: 'POST',
      url: '/api/sendText',
      payload: { session: 'default', chatId: '5511999990475@c.us', text: 'Hello' },
    });
    const capping = await call({ method: 'GET', url: '/api/sessions/default/capping' });

    expect(JSON.stringify(sent.body)).toContain('server returned error 475');
    expect(capping.body.cappingStatus).toBe('CAPPED');
  });
});

describe('what the platform does in a chat', () => {
  it('records seen, typing and the send in the order they happened', async () => {
    await createWorkingSession();
    const chat = { session: 'default', chatId: '5511999998888@c.us' };

    await call({ method: 'POST', url: '/api/sendSeen', payload: chat });
    await call({ method: 'POST', url: '/api/startTyping', payload: chat });
    await call({ method: 'POST', url: '/api/stopTyping', payload: chat });
    await call({ method: 'POST', url: '/api/sendText', payload: { ...chat, text: 'Hello' } });

    const state = await call({ method: 'GET', url: '/__stub/state' });

    expect(state.body.chatActivity).toStrictEqual([
      { action: 'seen', chatId: chat.chatId },
      { action: 'typing_started', chatId: chat.chatId },
      { action: 'typing_stopped', chatId: chat.chatId },
      { action: 'sent', chatId: chat.chatId },
    ]);
  });

  it('refuses to show typing on a session that is not connected', async () => {
    await call({ method: 'POST', url: '/api/sessions', payload: { name: 'default', start: true } });

    const typing = await call({
      method: 'POST',
      url: '/api/startTyping',
      payload: { session: 'default', chatId: '5511999998888@c.us' },
    });

    expect(typing.statusCode).toBe(422);
  });

  it('counts recipient lookups, so a caller that repeats them can be caught', async () => {
    await call({
      method: 'GET',
      url: '/api/contacts/check-exists?phone=5511999998888&session=default',
    });
    await call({
      method: 'GET',
      url: '/api/contacts/check-exists?phone=5511999998888&session=default',
    });

    const state = await call({ method: 'GET', url: '/__stub/state' });

    expect(state.body.recipientLookupCount).toBe(2);
  });
});
