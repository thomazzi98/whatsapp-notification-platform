import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { runWithCorrelationContext } from './correlation-context';
import { createLogger } from './logger';
import { redactionCensorValue } from './redaction';

interface CapturedLogger {
  readonly logger: ReturnType<typeof createLogger>;
  readonly lines: () => Record<string, unknown>[];
}

function createCapturedLogger(): CapturedLogger {
  const captured: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      captured.push(chunk.toString('utf8'));
      callback();
    },
  });

  const logger = createLogger({
    serviceName: 'test-service',
    level: 'trace',
    format: 'json',
    nodeEnvironment: 'test',
    destination,
  });

  return {
    logger,
    lines: () =>
      captured
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('createLogger', () => {
  it('emits structured JSON with the service identity', () => {
    const { logger, lines } = createCapturedLogger();

    logger.info({ event: 'test.event' }, 'something happened');

    const [line] = lines();
    expect(line?.service).toBe('test-service');
    expect(line?.environment).toBe('test');
    expect(line?.level).toBe('info');
    expect(line?.message).toBe('something happened');
    expect(line?.event).toBe('test.event');
  });

  it('stamps the active correlation context onto every line without being asked', () => {
    const { logger, lines } = createCapturedLogger();

    runWithCorrelationContext(
      { correlationId: 'correlation-9', applicationId: 'app-9', notificationId: 'notification-9' },
      () => {
        logger.info({ event: 'test.event' }, 'inside a scope');
      },
    );

    const [line] = lines();
    expect(line?.correlationId).toBe('correlation-9');
    expect(line?.applicationId).toBe('app-9');
    expect(line?.notificationId).toBe('notification-9');
  });

  it('redacts credentials', () => {
    const { logger, lines } = createCapturedLogger();

    logger.info(
      {
        event: 'test.event',
        apiKey: 'wnp_live_should_never_appear',
        plaintextKey: 'wnp_live_also_secret',
        password: 'hunter2',
        webhookHmacKey: 'signing-key',
        // The names the platform actually uses for the callback secret.
        webhookSigningKey: 'the-real-callback-secret',
        signingKey: 'the-same-secret-while-generated',
      },
      'credentials',
    );

    const raw = JSON.stringify(lines()[0]);
    expect(raw).not.toContain('wnp_live_should_never_appear');
    expect(raw).not.toContain('wnp_live_also_secret');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('signing-key');
    expect(raw).not.toContain('the-real-callback-secret');
    expect(raw).not.toContain('the-same-secret-while-generated');
    expect(lines()[0]?.apiKey).toBe(redactionCensorValue);
  });

  it('redacts message content and recipient identity, which are customer personal data', () => {
    const { logger, lines } = createCapturedLogger();

    logger.info(
      {
        event: 'test.event',
        recipient: '+5511999998888',
        chatId: '5511999998888@c.us',
        renderedBody: 'Your order ORD-123 has shipped',
        templateVariables: { customerName: 'Rafael' },
      },
      'message content',
    );

    const raw = JSON.stringify(lines()[0]);
    expect(raw).not.toContain('5511999998888');
    expect(raw).not.toContain('ORD-123');
    expect(raw).not.toContain('Rafael');
  });

  it('redacts authorization headers', () => {
    const { logger, lines } = createCapturedLogger();

    logger.info(
      {
        event: 'http.request.completed',
        request: {
          headers: {
            authorization: 'Bearer wnp_live_secret_token',
            cookie: 'wnp_session=abcdef',
            'x-api-key': 'waha-secret',
          },
        },
      },
      'request',
    );

    const raw = JSON.stringify(lines()[0]);
    expect(raw).not.toContain('wnp_live_secret_token');
    expect(raw).not.toContain('abcdef');
    expect(raw).not.toContain('waha-secret');
  });

  it('keeps the safe derived recipient fields, which is what makes redaction workable', () => {
    const { logger, lines } = createCapturedLogger();

    logger.info(
      { event: 'test.event', recipientHash: 'a1b2c3d4e5f6', recipientMasked: '+55*******8888' },
      'derived fields',
    );

    const [line] = lines();
    expect(line?.recipientHash).toBe('a1b2c3d4e5f6');
    expect(line?.recipientMasked).toBe('+55*******8888');
  });

  it('honours the configured level', () => {
    const captured: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        captured.push(chunk.toString('utf8'));
        callback();
      },
    });
    const logger = createLogger({
      serviceName: 'test-service',
      level: 'warn',
      format: 'json',
      nodeEnvironment: 'test',
      destination,
    });

    logger.info({ event: 'ignored' }, 'below the threshold');
    logger.warn({ event: 'kept' }, 'at the threshold');

    expect(captured.join('')).not.toContain('below the threshold');
    expect(captured.join('')).toContain('at the threshold');
  });
});

describe('logging an error', () => {
  it('keeps what identifies it and drops what the driver attached', () => {
    const { logger, lines } = createCapturedLogger();
    const failure = Object.assign(new Error('terminating connection'), {
      code: '57P01',
      // A pg error carries its whole client, including where it connects and
      // as whom. Copying that into a log line is several kilobytes of
      // internals, and some of them are not ours to write down.
      client: { connectionParameters: { user: 'platform_application', host: 'postgres' } },
    });

    logger.error({ error: failure }, 'A pooled database client failed');

    const [line] = lines();
    const logged = line?.error as Record<string, unknown>;
    expect(logged.type).toBe('Error');
    expect(logged.message).toBe('terminating connection');
    expect(logged.code).toBe('57P01');
    expect(logged.client).toBeUndefined();
  });

  it('reports what a thrown plain object actually said', () => {
    const { logger, lines } = createCapturedLogger();
    // Exactly what pg-boss emits when a worker is stopped mid-flight. It is not
    // an Error, so the serializer used to render the whole thing as
    // "[object Object]" and the operator learned only that something failed.
    const failure = { queue: 'notification.dispatch', reason: 'wip', jobs: 3 };

    logger.error({ error: failure }, 'The queue client reported a failure');

    const [line] = lines();
    const logged = line?.error as Record<string, unknown>;
    expect(logged.message).not.toBe('[object Object]');
    expect(logged.queue).toBe('notification.dispatch');
    expect(logged.reason).toBe('wip');
    expect(logged.jobs).toBe(3);
  });

  it('does not copy a whole driver in through the plain-object path', () => {
    const { logger, lines } = createCapturedLogger();
    const failure = Object.fromEntries(
      Array.from({ length: 40 }, (unused, index) => [`field${String(index)}`, index]),
    );

    logger.error({ error: failure }, 'Something emitted a large object');

    const [line] = lines();
    const logged = line?.error as Record<string, unknown>;
    // The ten fields plus the type that says why they are there.
    expect(Object.keys(logged)).toHaveLength(11);
  });

  it('withholds the statement and parameters drizzle puts in a query error', () => {
    const { logger, lines } = createCapturedLogger();
    // The exact shape drizzle throws: the message is the SQL followed by every
    // bound value, and Error.stack repeats that message on its first line. The
    // redaction list matches field paths and can never look inside a string, so
    // one failing insert used to write the recipient and the body to the log.
    const failure = Object.assign(
      new Error(
        'Failed query: insert into notifications (recipient_phone_number, rendered_body) values ($1, $2)\nparams: +5511999998888,Your order has shipped Maria',
        { cause: new Error('duplicate key value violates unique constraint') },
      ),
      {
        query: 'insert into notifications (recipient_phone_number, rendered_body) values ($1, $2)',
        params: ['+5511999998888', 'Your order has shipped Maria'],
      },
    );

    logger.error({ error: failure }, 'A write failed');

    const serialised = JSON.stringify(lines()[0]);
    expect(serialised).not.toContain('5511999998888');
    expect(serialised).not.toContain('Your order has shipped');
    expect(serialised).not.toContain('insert into notifications');
    // The reason Postgres gave still has to survive, or the line is useless.
    expect(serialised).toContain('duplicate key value violates unique constraint');
  });

  it('keeps the frames of a withheld query error, so it can still be located', () => {
    const { logger, lines } = createCapturedLogger();
    const failure = Object.assign(new Error('Failed query: select 1\nparams: secret-value'), {
      query: 'select 1',
      params: ['secret-value'],
    });
    failure.stack =
      'Error: Failed query: select 1\nparams: secret-value\n    at doWrite (repo.ts:1:1)';

    logger.error({ error: failure }, 'A write failed');

    const logged = lines()[0]?.error as { stack?: string };
    expect(logged.stack).toContain('at doWrite');
    expect(logged.stack).not.toContain('secret-value');
  });

  it('keeps a cause, because that is usually the real reason', () => {
    const { logger, lines } = createCapturedLogger();
    const failure = new Error('Failed query', { cause: new Error('permission denied') });

    logger.error({ error: failure }, 'The query failed');

    const [line] = lines();
    const logged = line?.error as { cause?: { message?: string } };
    expect(logged.cause?.message).toBe('permission denied');
  });
});

describe('logging a whole configuration object', () => {
  it('redacts every secret in it, at whatever depth it sits', () => {
    const { logger, lines } = createCapturedLogger();
    // The shape the platform actually holds. Logging it while debugging a boot
    // problem is the obvious thing to do, and pino matches paths literally —
    // a name on the list does not protect a value two levels below it.
    const configuration = {
      database: {
        applicationUrl: 'postgres://app:not-a-real-password-one@postgres:5432/notifications',
        systemUrl: 'postgres://system:not-a-real-password-two@postgres:5432/notifications',
        maximumPoolSize: 10,
      },
      security: {
        apiKeyPepper: 'K9xW2Qm7ZrT5vY8nH4jL6pD1sG0fCuE7iO9kM2aXbNc=',
        encryptionKey: 'aB3xK9mQ7wZ2rT5vY8nH4jL6pD1sG0fCuE7iO9kM2aX=',
        cursorSigningKey: 'Zq8Xw2Qm7ZrT5vY8nH4jL6pD1sG0fCuE7iO9kM2aXbN=',
        sessionCookieName: 'wnp_session',
      },
      observability: {
        recipientSalt: 'Rs9Xw2Qm7ZrT5vY8nH4jL6pD1sG0fCuE7iO9kM2aXbN=',
        logLevel: 'info',
      },
      whatsAppProvider: {
        apiKey: 'Wk9Xw2Qm7ZrT5vY8nH4jL6pD1sG0fCuE7iO9kM2aXbN=',
        baseUrl: 'http://waha:3000',
      },
    };

    logger.info({ configuration }, 'Booting');

    const logged = JSON.stringify(lines()[0]);
    for (const secret of [
      'not-a-real-password-one',
      'not-a-real-password-two',
      configuration.security.apiKeyPepper,
      configuration.security.encryptionKey,
      configuration.security.cursorSigningKey,
      configuration.observability.recipientSalt,
      configuration.whatsAppProvider.apiKey,
    ]) {
      expect(logged).not.toContain(secret);
    }

    // The values that are not secrets still have to survive, or the line stops
    // being worth writing.
    expect(logged).toContain('wnp_session');
    expect(logged).toContain('http://waha:3000');
  });
});
