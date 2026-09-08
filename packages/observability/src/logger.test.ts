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
      },
      'credentials',
    );

    const raw = JSON.stringify(lines()[0]);
    expect(raw).not.toContain('wnp_live_should_never_appear');
    expect(raw).not.toContain('wnp_live_also_secret');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('signing-key');
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

  it('keeps a cause, because that is usually the real reason', () => {
    const { logger, lines } = createCapturedLogger();
    const failure = new Error('Failed query', { cause: new Error('permission denied') });

    logger.error({ error: failure }, 'The query failed');

    const [line] = lines();
    const logged = line?.error as { cause?: { message?: string } };
    expect(logged.cause?.message).toBe('permission denied');
  });
});
