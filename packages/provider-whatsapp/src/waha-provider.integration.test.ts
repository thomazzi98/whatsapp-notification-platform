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
/**
 * Where the stub sends callbacks nobody is listening for. A closed loopback
 * port refuses in milliseconds; an unresolvable name such as receiver.invalid
 * waits on the resolver, which took eleven seconds on one machine and turned
 * every session test into a timeout there while passing everywhere else.
 */
let unreachableReceiver: string;

beforeAll(async () => {
  stub = createStubServer({ apiKey });
  await stub.listen({ port: 0, host: '127.0.0.1' });

  const address = stub.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  provider = new WahaProvider({ baseUrl, apiKey, requestTimeoutMilliseconds: 2000 });
  unreachableReceiver = `${await findClosedPortUrl()}/webhooks`;
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

async function controlStub(path: string, body: unknown): Promise<void> {
  await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readChatActivity(): Promise<{ action: string; chatId: string }[]> {
  const response = await fetch(`${baseUrl}/__stub/state`);
  const state = (await response.json()) as { chatActivity: { action: string; chatId: string }[] };

  return state.chatActivity;
}

async function createConnectedSession(sessionName = 'default'): Promise<void> {
  await provider.createSession({
    sessionName,
    webhookUrl: unreachableReceiver,
    webhookSigningKey: 'a-signing-key',
    start: true,
  });
  await scan(sessionName);
}

describe('session lifecycle', () => {
  it('creates a session that is waiting for a code', async () => {
    const result = await provider.createSession({
      sessionName: 'default',
      webhookUrl: unreachableReceiver,
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

  it('offers a fresh round of codes once the last round expired unscanned', async () => {
    await provider.createSession({
      sessionName: 'default',
      webhookUrl: unreachableReceiver,
      webhookSigningKey: 'a-signing-key',
      start: true,
    });
    // Six codes, then the engine gives up on the session.
    for (let code = 0; code < 6; code += 1) {
      await fetch(`${baseUrl}/__stub/sessions/default/expire-qr`, { method: 'POST' });
    }

    const restarted = await provider.startSession('default');

    // Found against real WAHA: start on a FAILED session is a no-op, so the
    // dashboard's Start button left anyone who scanned too slowly stuck.
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
      webhookUrl: unreachableReceiver,
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
      webhookUrl: unreachableReceiver,
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
  it('reads the identifier out of the message the WEBJS engine answers with', async () => {
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

  it('still reads the key the NOWEB engine answers with', async () => {
    await createConnectedSession();
    await controlStub('/__stub/engine', { engine: 'NOWEB' });

    const result = await provider.sendTextMessage({
      sessionName: 'default',
      chatIdentifier: '5511999998888@c.us',
      text: 'Your order has shipped.',
    });

    expect(result).toMatchObject({
      outcome: 'succeeded',
      value: { providerMessageId: expect.stringMatching(/^STUB\d{6}$/) as unknown },
    });
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
      webhookUrl: unreachableReceiver,
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

describe('the limits WhatsApp places on the account', () => {
  it('reports nothing in force on an account nothing has happened to', async () => {
    await createConnectedSession();

    const session = await provider.getSession('default');

    expect(session).toMatchObject({
      outcome: 'succeeded',
      value: { accountLimits: { reachoutTimelock: null, newChatQuota: null } },
    });
  });

  it('reads the limits the session reports, without asking WhatsApp again', async () => {
    await createConnectedSession();
    await controlStub('/__stub/sessions/default/restrict', {
      timelockMinutes: 90,
      cappingStatus: 'SECOND_WARNING',
      usedQuota: 95,
      totalQuota: 100,
    });

    const session = await provider.getSession('default');

    expect(session.outcome).toBe('succeeded');
    if (session.outcome === 'succeeded') {
      const limits = session.value?.accountLimits;
      expect(limits?.reachoutTimelock?.isActive).toBe(true);
      expect(limits?.reachoutTimelock?.endsAt?.getTime()).toBeGreaterThan(Date.now());
      expect(limits?.newChatQuota).toMatchObject({
        status: 'SECOND_WARNING',
        used: 95,
        total: 100,
      });
    }
  });

  it('has no limits to report for a session nobody has paired', async () => {
    await provider.createSession({
      sessionName: 'default',
      webhookUrl: unreachableReceiver,
      webhookSigningKey: 'a-signing-key',
      start: true,
    });

    const session = await provider.getSession('default');

    expect(session).toMatchObject({ outcome: 'succeeded', value: { accountLimits: null } });
  });

  it('asks WhatsApp afresh when told to', async () => {
    await createConnectedSession();
    await controlStub('/__stub/sessions/default/restrict', { timelockMinutes: 30 });

    const limits = await provider.fetchAccountLimits('default');

    expect(limits).toMatchObject({
      outcome: 'succeeded',
      value: {
        reachoutTimelock: { isActive: true, enforcementType: 'DEFAULT' },
        newChatQuota: { status: 'NONE', total: -1 },
      },
    });
  });

  it('fails the fresh lookup only when neither half can be read', async () => {
    await createConnectedSession();
    await controlStub('/__stub/sessions/default/restrict', { lookupUnavailable: true });

    const limits = await provider.fetchAccountLimits('default');

    expect(limits.outcome).toBe('failed');
  });
});

describe('typing before a message', () => {
  it('marks the chat seen, shows typing for the time asked, then stops', async () => {
    await createConnectedSession();
    const waits: number[] = [];
    const typingProvider = new WahaProvider({
      baseUrl,
      apiKey,
      requestTimeoutMilliseconds: 2000,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        await Promise.resolve();
      },
    });

    const result = await typingProvider.showTyping({
      sessionName: 'default',
      chatIdentifier: '5511999998888@c.us',
      durationMilliseconds: 3500,
    });

    expect(result.outcome).toBe('succeeded');
    expect(waits).toStrictEqual([3500]);
    const activity = await readChatActivity();

    expect(activity.map((entry) => entry.action)).toStrictEqual([
      'seen',
      'typing_started',
      'typing_stopped',
    ]);
  });

  it('skips the wait when typing cannot start', async () => {
    // A session that is not connected, the way a chat WhatsApp Web has not
    // loaded refuses: there is no indicator to keep up, so nothing waits.
    await provider.createSession({
      sessionName: 'default',
      webhookUrl: unreachableReceiver,
      webhookSigningKey: 'a-signing-key',
      start: true,
    });
    const waits: number[] = [];
    const typingProvider = new WahaProvider({
      baseUrl,
      apiKey,
      requestTimeoutMilliseconds: 2000,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        await Promise.resolve();
      },
    });

    const result = await typingProvider.showTyping({
      sessionName: 'default',
      chatIdentifier: '5511999998888@c.us',
      durationMilliseconds: 3500,
    });

    expect(result.outcome).toBe('failed');
    expect(waits).toStrictEqual([]);
  });

  it('cuts the wait short when the worker is shutting down', async () => {
    await createConnectedSession();
    const controller = new AbortController();
    controller.abort();

    const startedAt = Date.now();
    const result = await provider.showTyping({
      sessionName: 'default',
      chatIdentifier: '5511999998888@c.us',
      durationMilliseconds: 10_000,
      abortSignal: controller.signal,
    });

    expect(Date.now() - startedAt).toBeLessThan(5000);
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
    {
      recipient: '5511999990463@c.us',
      code: 'connection_restricted',
      classification: 'PERMANENT',
    },
    {
      recipient: '5511999990475@c.us',
      code: 'new_chat_quota_exceeded',
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

  it('keeps the engine stack and the echoed request out of the failure message', async () => {
    // The real server answers an engine error with its stack and the request
    // that caused it, chat and text included, and the message reaches the
    // reason the public API returns.
    await createConnectedSession();
    await forceFailureMode('none');

    const refused = await provider.sendTextMessage({
      sessionName: 'default',
      chatIdentifier: '5511999990463@c.us',
      text: 'Hello',
    });

    expect(refused.outcome).toBe('failed');
    if (refused.outcome === 'failed') {
      expect(refused.failure.message).not.toMatch(/@c\.us|webjs|The message text|stack/i);
    }
  });

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
