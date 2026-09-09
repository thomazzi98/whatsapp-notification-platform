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
  it('answers with a key object, as the NOWEB engine does', async () => {
    await createWorkingSession();

    const sent = await call({
      method: 'POST',
      url: '/api/sendText',
      payload: { session: 'default', chatId: '5511999998888@c.us', text: 'Hello' },
    });
    const key = sent.body.key as { id?: string; fromMe?: boolean };

    expect(sent.statusCode).toBe(200);
    expect(key.id).toBeTypeOf('string');
    // No serialized identifier anywhere in the response: the send carries the
    // raw one, and only the acknowledgement serializes it.
    expect(JSON.stringify(sent.body)).not.toContain('true_');
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
          webhooks: [{ url: 'http://receiver.invalid/webhooks', events: ['message.ack'] }],
        },
      },
    });
    await call({ method: 'POST', url: '/__stub/sessions/default/scan', payload: {} });
    const sent = await call({
      method: 'POST',
      url: '/api/sendText',
      payload: { session: 'default', chatId: '5511999998888@c.us', text: 'Hello' },
    });
    const messageIdentifier = (sent.body.key as { id: string }).id;

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
