import Fastify, { type FastifyInstance } from 'fastify';

import {
  type FailureMode,
  failureModeForRecipient,
  isFailureMode,
  isUnregisteredNumber,
  responseForFailureMode,
} from './failure-modes';
import { renderQrPlaceholderPng } from './qr-image';
import { MAXIMUM_QR_ATTEMPTS, SessionStore, type StubSession } from './session-store';
import { WebhookSender } from './webhook-sender';

/**
 * The engines whose send response the stub can reproduce. Production runs
 * WEBJS; NOWEB stays reproducible because the adapter still reads its shape.
 */
const responseEngines = ['WEBJS', 'NOWEB'] as const;

type ResponseEngine = (typeof responseEngines)[number];

function isResponseEngine(candidate: string): candidate is ResponseEngine {
  return (responseEngines as readonly string[]).includes(candidate);
}

/** Something the platform asked WhatsApp to do in a chat, recorded in order. */
interface ChatActivity {
  readonly action: 'seen' | 'typing_started' | 'typing_stopped' | 'sent';
  readonly chatId: string;
}

/** Enough to assert on any one test's sequence without growing for ever. */
const MAXIMUM_RECORDED_CHAT_ACTIVITY = 200;

interface ChatActionBody {
  readonly session?: string;
  readonly chatId?: string;
}

interface RestrictionBody {
  /** Minutes until the timelock lifts; zero or less lifts it now. */
  readonly timelockMinutes?: number;
  /** A timelock in force with no end WhatsApp would say. */
  readonly timelockWithoutEnd?: boolean;
  readonly enforcementType?: string;
  readonly cappingStatus?: string;
  readonly usedQuota?: number;
  readonly totalQuota?: number;
  /** Makes the live lookups answer as an engine that cannot read them does. */
  readonly lookupUnavailable?: boolean;
}

function applyRestriction(session: StubSession, body: RestrictionBody, now: number): void {
  const nowSeconds = Math.floor(now / 1000);

  if (body.timelockWithoutEnd === true) {
    session.reachoutTimelock = {
      enforcementType: body.enforcementType ?? session.reachoutTimelock.enforcementType,
      isActive: true,
      timeEnforcementEnds: null,
    };
  }
  if (body.timelockMinutes !== undefined) {
    const isActive = body.timelockMinutes > 0;
    session.reachoutTimelock = {
      enforcementType: body.enforcementType ?? session.reachoutTimelock.enforcementType,
      isActive,
      timeEnforcementEnds: isActive ? nowSeconds + Math.round(body.timelockMinutes * 60) : null,
    };
  }
  if (body.cappingStatus !== undefined) {
    session.messageCapping = {
      ...session.messageCapping,
      cappingStatus: body.cappingStatus,
      totalQuota: body.totalQuota ?? session.messageCapping.totalQuota,
      usedQuota: body.usedQuota ?? session.messageCapping.usedQuota,
      cycleStart: nowSeconds,
      cycleEnd: nowSeconds + 30 * 24 * 3600,
    };
  }
}

/**
 * What WAHA attaches to a WORKING status: only the restrictions in force, and
 * nothing at all when none is. An absent timelock therefore means none is
 * known, not that one has lifted.
 */
function toRestrictionData(session: StubSession): Record<string, unknown> | null {
  const data: Record<string, unknown> = {};

  if (session.reachoutTimelock.isActive) {
    data.reachoutTimelock = session.reachoutTimelock;
  }
  if (session.messageCapping.cappingStatus !== 'NONE') {
    data.messageCapping = session.messageCapping;
  }
  return Object.keys(data).length > 0 ? data : null;
}

/** The WEBJS shape: the WhatsApp Web message object, identifier nested. */
function toWebjsSentMessage(
  chatIdentifier: string,
  messageIdentifier: string,
  text: string,
  senderPhoneNumber: string,
  sentAtSeconds: number,
): Record<string, unknown> {
  return {
    id: {
      fromMe: true,
      remote: chatIdentifier,
      id: messageIdentifier,
      _serialized: `true_${chatIdentifier}_${messageIdentifier}`,
    },
    ack: 0,
    body: text,
    type: 'chat',
    timestamp: sentAtSeconds,
    from: `${senderPhoneNumber}@c.us`,
    to: chatIdentifier,
    hasMedia: false,
  };
}

/** The NOWEB shape: a Baileys key, with no serialized form anywhere. */
function toNowebSentMessage(
  chatIdentifier: string,
  messageIdentifier: string,
  text: string,
  _senderPhoneNumber: string,
  sentAtSeconds: number,
): Record<string, unknown> {
  return {
    key: {
      remoteJid: chatIdentifier.replace('@c.us', '@s.whatsapp.net'),
      fromMe: true,
      id: messageIdentifier,
    },
    message: { extendedTextMessage: { text } },
    messageTimestamp: String(sentAtSeconds),
    status: 'PENDING',
  };
}

const sentMessageByEngine: Record<ResponseEngine, typeof toWebjsSentMessage> = {
  WEBJS: toWebjsSentMessage,
  NOWEB: toNowebSentMessage,
};

export interface StubServerOptions {
  readonly apiKey: string;
}

interface SessionRequestBody {
  readonly name?: string;
  readonly start?: boolean;
  readonly config?: {
    readonly webhooks?: {
      readonly url: string;
      readonly events: string[];
      readonly hmac?: { readonly key?: string };
    }[];
  };
}

interface SendTextBody {
  readonly session?: string;
  readonly chatId?: string;
  readonly text?: string;
}

/**
 * The account's linked-device identifier, which is what acknowledgements name.
 *
 * The real engine reports a different address on the send than on the receipt —
 * the send names the phone number and the acknowledgement names this — so the
 * stub models that difference deliberately. A stub that used one address for
 * both would let a platform that compares the serialized strings pass here and
 * fail against WhatsApp.
 */
const LINKED_DEVICE_IDENTIFIER = '165515288932355@lid';

function toSessionResponse(session: StubSession): Record<string, unknown> {
  return {
    name: session.name,
    status: session.status,
    me:
      session.phoneNumber === null
        ? null
        : {
            id: `${session.phoneNumber}@c.us`,
            pushName: session.pushName,
            // What the engine last heard from WhatsApp, served without asking
            // again: null until an enforcement has been seen.
            reachoutTimelock: session.reachoutTimelock.isActive ? session.reachoutTimelock : null,
            messageCapping:
              session.messageCapping.cappingStatus === 'NONE' ? null : session.messageCapping,
          },
  };
}

/**
 * A deterministic stand-in for WAHA.
 *
 * It exists so every milestone before the real WhatsApp step can be verified
 * without a phone, a scannable QR code or an account that can be banned. It
 * models the parts of the real contract the platform depends on — the session
 * lifecycle, the six-code QR budget, the message identifier the send and the
 * acknowledgement disagree about, and acknowledgements that arrive out of
 * order — and adds a control plane for
 * provoking failures on demand.
 */
export function createStubServer(options: StubServerOptions): FastifyInstance {
  // Idle keep-alive sockets are what a client leaves behind, and Node's close
  // waits for them. A stub whose lifetime is one test run should go when it is
  // told to: without this, closing it waited on the caller's pooled connection
  // and the hook timed out with every test already passed.
  const server = Fastify({ logger: false, forceCloseConnections: true });
  const sessions = new SessionStore();
  const webhooks = new WebhookSender();
  let forcedFailureMode: FailureMode = 'none';
  let sentMessageCounter = 0;
  let recipientLookupCount = 0;
  let responseEngine: ResponseEngine = 'WEBJS';
  let isAccountLimitsLookupUnavailable = false;
  let chatActivity: ChatActivity[] = [];

  const recordChatActivity = (activity: ChatActivity): void => {
    chatActivity = [...chatActivity, activity].slice(-MAXIMUM_RECORDED_CHAT_ACTIVITY);
  };

  /** Repeats the status with the restrictions in force, as WAHA does when they change. */
  const announceRestrictions = async (session: StubSession): Promise<void> => {
    await webhooks.send(
      session.webhooks,
      session.name,
      'session.status',
      {
        name: session.name,
        status: session.status,
        statuses: [{ status: session.status, timestamp: Date.now() }],
        data: toRestrictionData(session),
      },
      session.phoneNumber === null
        ? null
        : { id: `${session.phoneNumber}@c.us`, pushName: session.pushName ?? '' },
    );
  };
  /**
   * Holds a send open for a bounded time. Distinct from the `timeout` failure
   * mode, which never answers at all: this one still succeeds, which is what
   * lets a test act on the database while a send is genuinely in flight.
   */
  let sendDelayMilliseconds = 0;

  server.addHook('onRequest', (request, reply, done) => {
    // /ping and the control plane are deliberately unauthenticated, matching
    // the real server for /ping and keeping test setup simple.
    if (request.url.startsWith('/ping') || request.url.startsWith('/__stub')) {
      done();
      return;
    }
    if (request.headers['x-api-key'] !== options.apiKey) {
      void reply.status(401).send({ message: 'Unauthorized' });
      return;
    }
    done();
  });

  server.get('/ping', () => ({ message: 'pong' }));

  server.get('/api/server/version', () => ({
    version: 'stub',
    engine: 'WEBJS',
    tier: 'CORE',
    browser: '/usr/bin/chromium',
  }));

  server.post('/api/sessions', async (request, reply) => {
    const body = request.body as SessionRequestBody;
    const name = body.name ?? 'default';

    if (sessions.find(name) !== undefined) {
      return reply.status(422).send({ message: `Session ${name} already exists.` });
    }

    const session = sessions.create(name, body.config?.webhooks ?? []);
    if (body.start === true) {
      sessions.start(session, Date.now());
      await webhooks.send(
        session.webhooks,
        name,
        'session.status',
        {
          name,
          status: session.status,
        },
        null,
      );
    }

    return reply.status(201).send(toSessionResponse(session));
  });

  server.get('/api/sessions', () => sessions.list().map((session) => toSessionResponse(session)));

  server.get<{ Params: { session: string } }>('/api/sessions/:session', (request, reply) => {
    const session = sessions.find(request.params.session);
    if (session === undefined) {
      return reply.status(404).send({ message: 'Session not found.' });
    }
    return reply.send(toSessionResponse(session));
  });

  server.get<{ Params: { session: string } }>('/api/sessions/:session/me', (request, reply) => {
    const session = sessions.find(request.params.session);
    if (session?.phoneNumber == null) {
      return reply.send(null);
    }
    return reply.send({
      id: `${session.phoneNumber}@c.us`,
      pushName: session.pushName,
    });
  });

  /**
   * The live lookups. Each asks WhatsApp afresh on the real server, and an
   * engine whose WhatsApp Web build lacks the data answers 501.
   */
  server.get<{ Params: { session: string } }>(
    '/api/sessions/:session/timelock',
    (request, reply) => {
      const session = sessions.find(request.params.session);
      if (session === undefined) {
        return reply.status(404).send({ message: 'Session not found.' });
      }
      if (isAccountLimitsLookupUnavailable) {
        return reply.status(501).send({ message: 'Not implemented by this engine.' });
      }
      return reply.send(session.reachoutTimelock);
    },
  );

  server.get<{ Params: { session: string } }>(
    '/api/sessions/:session/capping',
    (request, reply) => {
      const session = sessions.find(request.params.session);
      if (session === undefined) {
        return reply.status(404).send({ message: 'Session not found.' });
      }
      if (isAccountLimitsLookupUnavailable) {
        return reply.status(501).send({ message: 'Not implemented by this engine.' });
      }
      return reply.send(session.messageCapping);
    },
  );

  for (const action of ['start', 'stop', 'logout', 'restart'] as const) {
    server.post<{ Params: { session: string } }>(
      `/api/sessions/:session/${action}`,
      async (request, reply) => {
        const session = sessions.find(request.params.session);
        if (session === undefined) {
          return reply.status(404).send({ message: 'Session not found.' });
        }

        const applyAction: Record<typeof action, () => void> = {
          start: () => {
            // Observed against noweb-2026.8.2: start on a session whose codes
            // ran out answers 201 and changes nothing. The stub used to start
            // it anyway, which is exactly what hid the dashboard's Start button
            // doing nothing for anyone who took too long to scan.
            if (session.status === 'FAILED') {
              return;
            }
            sessions.start(session, Date.now());
          },
          restart: () => {
            sessions.start(session, Date.now());
          },
          stop: () => {
            session.status = 'STOPPED';
          },
          logout: () => {
            sessions.logout(session);
          },
        };
        applyAction[action]();

        await webhooks.send(
          session.webhooks,
          session.name,
          'session.status',
          {
            name: session.name,
            status: session.status,
          },
          null,
        );

        return reply.send(toSessionResponse(session));
      },
    );
  }

  server.delete<{ Params: { session: string } }>('/api/sessions/:session', (request, reply) => {
    sessions.remove(request.params.session);
    return reply.status(200).send({});
  });

  server.get<{ Params: { session: string }; Querystring: { format?: string } }>(
    '/api/:session/auth/qr',
    (request, reply) => {
      const session = sessions.find(request.params.session);
      if (session === undefined) {
        return reply.status(404).send({ message: 'Session not found.' });
      }
      if (session.status !== 'SCAN_QR_CODE') {
        return reply.status(422).send({ message: 'The session is not waiting for a QR code.' });
      }

      const value = `2@stub-${session.name}-${String(session.qrAttempt)}`;
      if (request.query.format === 'raw') {
        return reply.send({ value });
      }
      return reply.send({
        mimetype: 'image/png',
        data: renderQrPlaceholderPng(value).toString('base64'),
      });
    },
  );

  server.get<{ Querystring: { phone?: string; session?: string } }>(
    '/api/contacts/check-exists',
    (request, reply) => {
      const phone = request.query.phone ?? '';
      recipientLookupCount += 1;

      const failure = responseForFailureMode(forcedFailureMode);
      if (failure !== undefined) {
        return reply
          .status(failure.statusCode)
          .headers(failure.headers ?? {})
          .send(failure.body);
      }
      if (isUnregisteredNumber(phone)) {
        return reply.send({ numberExists: false, chatId: null });
      }
      return reply.send({ numberExists: true, chatId: `${phone.replaceAll(/\D/g, '')}@c.us` });
    },
  );

  server.post('/api/sendText', async (request, reply) => {
    const body = request.body as SendTextBody;
    const chatIdentifier = body.chatId ?? '';
    const session = sessions.find(body.session ?? 'default');

    const mode =
      forcedFailureMode === 'none' ? failureModeForRecipient(chatIdentifier) : forcedFailureMode;

    if (mode === 'timeout') {
      // Never answers: the caller's own timeout is what ends this, which is the
      // condition that leaves an attempt with an unknown outcome. It does settle
      // once the caller gives up and the socket closes, because a handler that
      // never returns is one the server can never finish closing -- which
      // surfaced as a hung afterAll rather than as anything to do with sending.
      await new Promise<void>((resolve) => {
        request.raw.once('close', resolve);
      });

      return reply;
    }
    if (mode === 'connection_reset') {
      // The socket, not the request stream: destroying the stream alone leaves
      // the caller waiting until its own timeout, which is a different failure.
      request.raw.socket.destroy();
      return reply;
    }

    const failure = responseForFailureMode(mode);
    if (failure !== undefined) {
      // A refusal for reaching out also changes what the account reports, as it
      // does on the engine that refreshes its record when WhatsApp refuses.
      if (session !== undefined && mode === 'reachout_timelock') {
        applyRestriction(session, { timelockMinutes: 60 }, Date.now());
        await announceRestrictions(session);
      }
      if (session !== undefined && mode === 'message_capping') {
        applyRestriction(
          session,
          { cappingStatus: 'CAPPED', usedQuota: 50, totalQuota: 50 },
          Date.now(),
        );
        await announceRestrictions(session);
      }
      // The header included: a provider that says how long to wait and one that
      // does not are different failures, and the caller is meant to notice.
      return reply
        .status(failure.statusCode)
        .headers(failure.headers ?? {})
        .send(failure.body);
    }

    if (sendDelayMilliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, sendDelayMilliseconds));
    }

    if (session?.status !== 'WORKING') {
      return reply.status(422).send({ message: 'The session is not connected.' });
    }

    sentMessageCounter += 1;
    const messageIdentifier = `STUB${String(sentMessageCounter).padStart(6, '0')}`;
    const sentAtSeconds = Math.floor(Date.now() / 1000);
    recordChatActivity({ action: 'sent', chatId: chatIdentifier });

    // Shaped as the engine production runs answers, WEBJS unless a test asked
    // for another. Neither carries the identifier the acknowledgement will use
    // (see /__stub/sessions/:session/acknowledge): only the final segment is
    // common to both.
    return reply.send(
      sentMessageByEngine[responseEngine](
        chatIdentifier,
        messageIdentifier,
        body.text ?? '',
        session.phoneNumber ?? '',
        sentAtSeconds,
      ),
    );
  });

  const chatActions = [
    ['/api/sendSeen', 'seen'],
    ['/api/startTyping', 'typing_started'],
    ['/api/stopTyping', 'typing_stopped'],
  ] as const;

  for (const [path, action] of chatActions) {
    server.post(path, (request, reply) => {
      const body = request.body as ChatActionBody;

      const failure = responseForFailureMode(forcedFailureMode);
      if (failure !== undefined) {
        return reply.status(failure.statusCode).send(failure.body);
      }
      if (sessions.find(body.session ?? 'default')?.status !== 'WORKING') {
        return reply.status(422).send({ message: 'The session is not connected.' });
      }

      recordChatActivity({ action, chatId: body.chatId ?? '' });
      return reply.status(201).send({});
    });
  }

  registerControlPlane();

  return server;

  function registerControlPlane(): void {
    server.post('/__stub/reset', (_request, reply) => {
      sessions.reset();
      webhooks.clear();
      forcedFailureMode = 'none';
      sentMessageCounter = 0;
      sendDelayMilliseconds = 0;
      recipientLookupCount = 0;
      responseEngine = 'WEBJS';
      isAccountLimitsLookupUnavailable = false;
      chatActivity = [];
      return reply.send({ reset: true });
    });

    server.post<{ Body: { milliseconds?: number } }>('/__stub/send-delay', (request, reply) => {
      sendDelayMilliseconds = Math.max(0, Math.min(request.body.milliseconds ?? 0, 30_000));

      return reply.send({ sendDelayMilliseconds });
    });

    /** Answers sends as another engine does, so the adapter's other readings stay tested. */
    server.post<{ Body: { engine?: string } }>('/__stub/engine', (request, reply) => {
      const engine = request.body.engine ?? 'WEBJS';
      if (!isResponseEngine(engine)) {
        return reply.status(400).send({ message: `Unknown engine: ${engine}` });
      }
      responseEngine = engine;
      return reply.send({ engine });
    });

    /**
     * Stands in for WhatsApp restricting the account: sets what the session
     * reports, and repeats its status with the restrictions in force.
     */
    server.post<{ Params: { session: string }; Body: RestrictionBody }>(
      '/__stub/sessions/:session/restrict',
      async (request, reply) => {
        const session = sessions.find(request.params.session);
        if (session === undefined) {
          return reply.status(404).send({ message: 'Session not found.' });
        }

        applyRestriction(session, request.body, Date.now());
        isAccountLimitsLookupUnavailable =
          request.body.lookupUnavailable ?? isAccountLimitsLookupUnavailable;
        await announceRestrictions(session);

        return reply.send({
          reachoutTimelock: session.reachoutTimelock,
          messageCapping: session.messageCapping,
        });
      },
    );

    server.post<{ Body: { mode?: string } }>('/__stub/failure-mode', (request, reply) => {
      const mode = request.body.mode ?? 'none';
      if (!isFailureMode(mode)) {
        return reply.status(400).send({ message: `Unknown failure mode: ${mode}` });
      }
      forcedFailureMode = mode;
      return reply.send({ mode });
    });

    /** Stands in for a human scanning the code. */
    server.post<{ Params: { session: string }; Body: { phoneNumber?: string } }>(
      '/__stub/sessions/:session/scan',
      async (request, reply) => {
        const session = sessions.find(request.params.session);
        if (session === undefined) {
          return reply.status(404).send({ message: 'Session not found.' });
        }

        const phoneNumber = request.body.phoneNumber ?? '5511999990000';
        sessions.completeScan(session, phoneNumber, 'Stub Account');
        await webhooks.send(
          session.webhooks,
          session.name,
          'session.status',
          {
            name: session.name,
            status: session.status,
          },
          { id: `${phoneNumber}@c.us`, pushName: 'Stub Account' },
        );

        return reply.send(toSessionResponse(session));
      },
    );

    /** Expires the current code, so the six-attempt budget can be exercised. */
    server.post<{ Params: { session: string } }>(
      '/__stub/sessions/:session/expire-qr',
      async (request, reply) => {
        const session = sessions.find(request.params.session);
        if (session === undefined) {
          return reply.status(404).send({ message: 'Session not found.' });
        }

        sessions.issueNextQrCode(session, Date.now());
        await webhooks.send(
          session.webhooks,
          session.name,
          'session.status',
          {
            name: session.name,
            status: session.status,
          },
          null,
        );

        return reply.send({
          status: session.status,
          qrAttempt: session.qrAttempt,
          maximumQrAttempts: MAXIMUM_QR_ATTEMPTS,
        });
      },
    );

    server.post<{
      Params: { session: string };
      Body: { messageId?: string; ack?: number };
    }>('/__stub/sessions/:session/acknowledge', async (request, reply) => {
      const session = sessions.find(request.params.session);
      if (session === undefined) {
        return reply.status(404).send({ message: 'Session not found.' });
      }

      const messageIdentifier = request.body.messageId ?? '';
      const acknowledgement = request.body.ack ?? 2;

      await webhooks.send(
        session.webhooks,
        session.name,
        'message.ack',
        {
          // Serialized, and addressed by the linked device rather than by the
          // number the send named — exactly as the real engine reports it.
          id: `true_${LINKED_DEVICE_IDENTIFIER}_${messageIdentifier}`,
          from: LINKED_DEVICE_IDENTIFIER,
          fromMe: true,
          ack: acknowledgement,
          ackName: ['ERROR', 'PENDING', 'SERVER', 'DEVICE', 'READ', 'PLAYED'][acknowledgement + 1],
        },
        null,
      );

      return reply.send({ delivered: true });
    });

    server.get('/__stub/webhooks', () => ({ deliveries: webhooks.recentDeliveries() }));

    server.get('/__stub/state', () => ({
      sessions: sessions.list(),
      forcedFailureMode,
      sentMessageCount: sentMessageCounter,
      recipientLookupCount,
      responseEngine,
      chatActivity,
    }));
  }
}
