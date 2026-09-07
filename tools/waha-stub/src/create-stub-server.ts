import { randomBytes } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

import {
  type FailureMode,
  failureModeForRecipient,
  isFailureMode,
  isUnregisteredNumber,
  responseForFailureMode,
} from './failure-modes';
import { MAXIMUM_QR_ATTEMPTS, SessionStore, type StubSession } from './session-store';
import { WebhookSender } from './webhook-sender';

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

const SENT_MESSAGE_PREFIX = 'true_';

function toSessionResponse(session: StubSession): Record<string, unknown> {
  return {
    name: session.name,
    status: session.status,
    me:
      session.phoneNumber === null
        ? null
        : { id: `${session.phoneNumber}@c.us`, pushName: session.pushName },
  };
}

/**
 * A deterministic stand-in for WAHA.
 *
 * It exists so every milestone before the real WhatsApp step can be verified
 * without a phone, a scannable QR code or an account that can be banned. It
 * models the parts of the real contract the platform depends on — the session
 * lifecycle, the six-code QR budget, the flat string message identifier, and
 * acknowledgements that arrive out of order — and adds a control plane for
 * provoking failures on demand.
 */
export function createStubServer(options: StubServerOptions): FastifyInstance {
  const server = Fastify({ logger: false });
  const sessions = new SessionStore();
  const webhooks = new WebhookSender();
  let forcedFailureMode: FailureMode = 'none';
  let sentMessageCounter = 0;

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
    engine: 'NOWEB',
    tier: 'CORE',
    browser: null,
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
        data: Buffer.from(value).toString('base64'),
      });
    },
  );

  server.get<{ Querystring: { phone?: string; session?: string } }>(
    '/api/contacts/check-exists',
    (request, reply) => {
      const phone = request.query.phone ?? '';

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
      // Never answers. The caller's own timeout is what ends this, which is the
      // condition that leaves an attempt with an unknown outcome.
      await new Promise(() => {
        // Intentionally never settles.
      });
    }
    if (mode === 'connection_reset') {
      request.raw.destroy();
      return reply;
    }

    const failure = responseForFailureMode(mode);
    if (failure !== undefined) {
      return reply.status(failure.statusCode).send(failure.body);
    }

    if (session?.status !== 'WORKING') {
      return reply.status(422).send({ message: 'The session is not connected.' });
    }

    sentMessageCounter += 1;
    const messageIdentifier = `${SENT_MESSAGE_PREFIX}${chatIdentifier}_STUB${String(sentMessageCounter).padStart(6, '0')}`;

    return reply.send({
      id: messageIdentifier,
      timestamp: Math.floor(Date.now() / 1000),
      from: `${session.phoneNumber ?? ''}@c.us`,
      to: chatIdentifier,
      fromMe: true,
      body: body.text ?? '',
      hasMedia: false,
      ack: 1,
      ackName: 'SERVER',
    });
  });

  registerControlPlane();

  return server;

  function registerControlPlane(): void {
    server.post('/__stub/reset', (_request, reply) => {
      sessions.reset();
      webhooks.clear();
      forcedFailureMode = 'none';
      sentMessageCounter = 0;
      return reply.send({ reset: true });
    });

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
          id: messageIdentifier,
          from: `${session.phoneNumber ?? ''}@c.us`,
          to: messageIdentifier.split('_', 2)[1] ?? '',
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
    }));
  }
}

export function generateStubApiKey(): string {
  return randomBytes(24).toString('hex');
}
