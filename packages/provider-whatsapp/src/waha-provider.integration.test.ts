import { type AddressInfo, createServer } from 'node:net';

import { createStubServer } from '@platform/waha-stub';
import { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WahaProvider } from './waha-provider';
import { toProviderEvent } from './webhook';

const apiKey = 'integration-stub-key';
let stub: FastifyInstance;
let provider: WahaProvider;
let baseUrl: string;

beforeAll(async () => {
  stub = createStubServer({ apiKey });
  await stub.listen({ port: 0, host: '127.0.0.1' });

  const address = stub.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  provider = new WahaProvider({ baseUrl, apiKey, requestTimeoutMilliseconds: 2000 });
});

afterAll(async () => {
  await stub.close();
});

beforeEach(async () => {
  await fetch(`${baseUrl}/__stub/reset`, { method: 'POST' });
});

async function scan(sessionName: string): Promise<void> {
  await fetch(`${baseUrl}/__stub/sessions/${sessionName}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phoneNumber: '5511999990000' }),
  });
}

async function forceFailureMode(mode: string): Promise<void> {
  await fetch(`${baseUrl}/__stub/failure-mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
}

async function createConnectedSession(sessionName = 'default'): Promise<void> {
  await provider.createSession({
    sessionName,
    webhookUrl: 'http://receiver.invalid/webhooks',
    webhookSigningKey: 'a-signing-key',
    start: true,
  });
  await scan(sessionName);
}

describe('session lifecycle', () => {
  it('creates a session that is waiting for a code', async () => {
    const result = await provider.createSession({
      sessionName: 'default',
      webhookUrl: 'http://receiver.invalid/webhooks',
      webhookSigningKey: 'a-signing-key',
      start: true,
    });

    expect(result.outcome).toBe('succeeded');
    if (result.outcome === 'succeeded') {
      expect(result.value.status).toBe('SCAN_QR_CODE');
    }
  });

  it('reports a missing session as absent rather than as a failure', async () => {
    // The platform uses this to decide between creating and starting, so a 404
    // has to be an answer.
    const result = await provider.getSession('never-created');

    expect(result.outcome).toBe('succeeded');
    if (result.outcome === 'succeeded') {
      expect(result.value).toBeUndefined();
    }
  });

  it('reads the connected identity once the code is scanned', async () => {
    await createConnectedSession();

    const result = await provider.getSession('default');

    expect(result.outcome).toBe('succeeded');
    if (result.outcome === 'succeeded') {
      expect(result.value?.status).toBe('WORKING');
      expect(result.value?.phoneNumber).toBe('+5511999990000');
      expect(result.value?.pushName).toBe('Stub Account');
    }
  });

  it('reconnects without a new code after stopping', async () => {
    await createConnectedSession();
    await provider.stopSession('default');

    const restarted = await provider.startSession('default');

    expect(restarted.outcome).toBe('succeeded');
    if (restarted.outcome === 'succeeded') {
      expect(restarted.value.status).toBe('WORKING');
    }
  });

  it('requires a new code after logging out', async () => {
    await createConnectedSession();
    await provider.logoutSession('default');

    const restarted = await provider.startSession('default');

    expect(restarted.outcome).toBe('succeeded');
    if (restarted.outcome === 'succeeded') {
      expect(restarted.value.status).toBe('SCAN_QR_CODE');
    }
  });

  it('reads an unrecognised status permissively rather than failing', async () => {
    // A newer provider release may add states; the poller must degrade rather
    // than crash.
    const result = await provider.createSession({
      sessionName: 'default',
      webhookUrl: 'http://receiver.invalid/webhooks',
      webhookSigningKey: 'key',
      start: false,
    });

    expect(result.outcome).toBe('succeeded');
  });
});

describe('qr codes', () => {
  it('fetches a base64 image', async () => {
    await provider.createSession({
      sessionName: 'default',
      webhookUrl: 'http://receiver.invalid/webhooks',
      webhookSigningKey: 'key',
      start: true,
    });

    const result = await provider.getQrCode('default');

    expect(result.outcome).toBe('succeeded');
    if (result.outcome === 'succeeded') {
      expect(result.value.mimeType).toBe('image/png');
      expect(result.value.data.length).toBeGreaterThan(0);
    }
  });

  it('fails when the session is not waiting for a code', async () => {
    await createConnectedSession();

    const result = await provider.getQrCode('default');

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.code).toBe('provider_invalid_request');
    }
  });
});

describe('recipient resolution', () => {
  it('returns the provider chat identifier rather than one built locally', async () => {
    await createConnectedSession();

    const result = await provider.resolveRecipient('default', '+55 11 99999-8888');

    expect(result.outcome).toBe('succeeded');
    if (result.outcome === 'succeeded') {
      expect(result.value.isRegistered).toBe(true);
      expect(result.value.chatIdentifier).toBe('5511999998888@c.us');
    }
  });

  it('reports a number that is not on WhatsApp', async () => {
    await createConnectedSession();

    const result = await provider.resolveRecipient('default', '+5511999990404');

    expect(result.outcome).toBe('succeeded');
    if (result.outcome === 'succeeded') {
      expect(result.value.isRegistered).toBe(false);
    }
  });

  it('classifies a lookup failure as retryable, unlike an unregistered number', async () => {
    await createConnectedSession();
    await forceFailureMode('server_error');

    const result = await provider.resolveRecipient('default', '+5511999998888');

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.code).toBe('recipient_check_failed');
      expect(result.failure.classification).toBe('RETRYABLE');
    }
  });

  it.each([
    ['unauthorized', 'provider_unauthorized'],
    ['invalid_request', 'provider_invalid_request'],
  ])('keeps a %s lookup permanent rather than relabelling it retryable', async (mode, code) => {
    await createConnectedSession();
    await forceFailureMode(mode);

    const result = await provider.resolveRecipient('default', '+5511999998888');

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      // A rejected key and a malformed request are both hopeless without a
      // human. Relabelling them here retried the lookup on the backoff curve
      // for the whole delivery window and never alerted anyone.
      expect(result.failure.code).toBe(code);
      expect(result.failure.classification).toBe('PERMANENT');
    }
  });
});

describe('sending', () => {
  it('reads the identifier out of the key the engine answers with', async () => {
    await createConnectedSession();

    const result = await provider.sendTextMessage({
      sessionName: 'default',
      chatIdentifier: '5511999998888@c.us',
      text: 'Your order has shipped.',
    });

    expect(result.outcome).toBe('succeeded');
    if (result.outcome === 'succeeded') {
      // The raw identifier, not a serialized form. The acknowledgement will
      // serialize it against a different address, so only this part matches.
      expect(result.value.providerMessageId).toMatch(/^STUB\d{6}$/);
    }
  });

  it('stores the identifier an acknowledgement will report', async () => {
    await createConnectedSession();
    const result = await provider.sendTextMessage({
      sessionName: 'default',
      chatIdentifier: '5511999998888@c.us',
      text: 'Your order has shipped.',
    });

    if (result.outcome !== 'succeeded') {
      throw new Error('The send should have succeeded.');
    }

    await fetch(`${baseUrl}/__stub/sessions/default/acknowledge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: result.value.providerMessageId, ack: 2 }),
    });
    const delivered = await fetch(`${baseUrl}/__stub/webhooks`);
    const body = (await delivered.json()) as {
      deliveries: { envelope: { event: string; payload: Record<string, unknown> } }[];
    };
    const acknowledgement = body.deliveries.find((entry) => entry.envelope.event === 'message.ack');

    // The whole point: what the send stored and what the receipt reports have
    // to reduce to the same thing, or no message ever reaches DELIVERED.
    const event = toProviderEvent({
      id: 'event-1',
      session: 'default',
      event: 'message.ack',
      payload: acknowledgement?.envelope.payload ?? {},
      me: null,
    });

    expect(event).toMatchObject({
      kind: 'message_acknowledgement',
      providerMessageId: result.value.providerMessageId,
    });
  });

  it('fails when the session is not connected', async () => {
    await provider.createSession({
      sessionName: 'default',
      webhookUrl: 'http://receiver.invalid/webhooks',
      webhookSigningKey: 'key',
      start: true,
    });

    const result = await provider.sendTextMessage({
      sessionName: 'default',
      chatIdentifier: '5511999998888@c.us',
      text: 'Hello',
    });

    expect(result.outcome).toBe('failed');
  });
});

describe('failure classification against a real server', () => {
  const cases = [
    { recipient: '5511999990500@c.us', code: 'provider_server_error', classification: 'RETRYABLE' },
    { recipient: '5511999990429@c.us', code: 'provider_rate_limited', classification: 'RETRYABLE' },
    {
      recipient: '5511999990401@c.us',
      code: 'provider_unauthorized',
      classification: 'PERMANENT',
    },
    {
      recipient: '5511999990422@c.us',
      code: 'provider_invalid_request',
      classification: 'PERMANENT',
    },
  ] as const;

  for (const testCase of cases) {
    it(`classifies ${testCase.code} as ${testCase.classification}`, async () => {
      await createConnectedSession();

      const result = await provider.sendTextMessage({
        sessionName: 'default',
        chatIdentifier: testCase.recipient,
        text: 'Hello',
      });

      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.failure.code).toBe(testCase.code);
        expect(result.failure.classification).toBe(testCase.classification);
      }
    });
  }

  it('classifies a connection dropped mid-request as an unknown outcome', async () => {
    await createConnectedSession();

    const result = await provider.sendTextMessage({
      sessionName: 'default',
      chatIdentifier: '5511999990499@c.us',
      text: 'Hello',
    });

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      // The request was written before the socket died, so whether WhatsApp
      // acted on it is unknowable from here.
      expect(result.failure.code).toBe('provider_connection_lost');
      expect(result.failure.classification).toBe('RETRYABLE');
    }
  });

  it('classifies a request that never answers as a timeout', async () => {
    await createConnectedSession();

    const result = await provider.sendTextMessage({
      sessionName: 'default',
      chatIdentifier: '5511999990408@c.us',
      text: 'Hello',
    });

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      // The outcome of this send is genuinely unknown: the message may have
      // been delivered. Retryable, but only after the attempt is resolved.
      expect(result.failure.code).toBe('provider_timeout');
      expect(result.failure.classification).toBe('RETRYABLE');
    }
  });

  it('reports an aborted request separately from a timeout', async () => {
    await createConnectedSession();
    const controller = new AbortController();
    // Deliberately not AbortSignal.timeout: this simulates the worker aborting
    // an in-flight request during shutdown, which the classifier must report
    // differently from the request timing out on its own.
    setTimeout(() => {
      controller.abort();
    }, 50);

    const result = await provider.sendTextMessage({
      sessionName: 'default',
      chatIdentifier: '5511999990408@c.us',
      text: 'Hello',
      abortSignal: controller.signal,
    });

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      // The worker aborts in-flight requests while shutting down, which is an
      // ordinary event rather than a provider problem.
      expect(result.failure.code).toBe('provider_aborted');
    }
  });

  it('rejects an unauthenticated provider as a permanent operator problem', async () => {
    const misconfigured = new WahaProvider({
      baseUrl,
      apiKey: 'the-wrong-key',
      requestTimeoutMilliseconds: 2000,
    });

    const result = await misconfigured.getSession('default');

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.code).toBe('provider_unauthorized');
      expect(result.failure.classification).toBe('PERMANENT');
    }
  });

  it('reports a refused connection as a send that certainly did not happen', async () => {
    const unreachable = new WahaProvider({
      baseUrl: await findClosedPortUrl(),
      apiKey,
      requestTimeoutMilliseconds: 1000,
    });

    const result = await unreachable.getSession('default');

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      // A refused connection is knowably a non-send, which is what keeps a
      // provider outage from permanently failing a fail-closed tenant's work.
      expect(result.failure.code).toBe('provider_unreachable');
      expect(result.failure.classification).toBe('RETRYABLE');
    }
  });
});

/**
 * A port nothing is listening on, obtained by binding one and letting it go.
 *
 * Hard-coding a low port does not work: the fetch specification refuses a list
 * of well-known ports outright, so the request never reaches the network and
 * the failure that comes back is not a connection error at all.
 */
async function findClosedPortUrl(): Promise<string> {
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

  return `http://127.0.0.1:${String(port)}`;
}
