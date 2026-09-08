import { hasUnknownOutcome } from '@platform/domain';
import { describe, expect, it } from 'vitest';

import { classifyHttpStatus, classifyTransportError } from './classify-failure';

describe('classifyHttpStatus', () => {
  it('treats server errors and rate limiting as retryable', () => {
    for (const status of [500, 502, 503, 504, 429]) {
      expect(classifyHttpStatus(status, 'failed').classification, String(status)).toBe('RETRYABLE');
    }
  });

  it('treats a rejected payload as permanent, because it will be rejected again', () => {
    expect(classifyHttpStatus(422, 'invalid').code).toBe('provider_invalid_request');
    expect(classifyHttpStatus(422, 'invalid').classification).toBe('PERMANENT');
  });

  it('treats bad credentials as permanent and operator actionable', () => {
    // Retrying would hide the fact that every send will fail until a human
    // fixes the platform's own configuration.
    for (const status of [401, 403]) {
      expect(classifyHttpStatus(status, 'denied').code, String(status)).toBe(
        'provider_unauthorized',
      );
      expect(classifyHttpStatus(status, 'denied').classification).toBe('PERMANENT');
    }
  });

  it('treats a missing session as permanent', () => {
    expect(classifyHttpStatus(404, 'gone').code).toBe('session_missing');
  });

  it('retries an unmapped status, conservatively', () => {
    const failure = classifyHttpStatus(418, 'unexpected');

    expect(failure.code).toBe('provider_unknown_error');
    expect(failure.classification).toBe('RETRYABLE');
  });

  it('records the status code for the delivery timeline', () => {
    expect(classifyHttpStatus(503, 'unavailable').providerStatusCode).toBe(503);
  });

  it('honours a Retry-After header when the provider sends one', () => {
    const headers = new Headers({ 'retry-after': '30' });

    expect(classifyHttpStatus(429, 'slow down', headers).retryAfterSeconds).toBe(30);
  });

  it('ignores a Retry-After value that is not a usable number', () => {
    for (const value of ['soon', '-5', '']) {
      const headers = new Headers({ 'retry-after': value });
      expect(
        classifyHttpStatus(429, 'slow down', headers).retryAfterSeconds,
        value,
      ).toBeUndefined();
    }
  });
});

describe('classifyTransportError', () => {
  it('reports an aborted request separately from a timeout', () => {
    // The worker aborts in-flight requests while shutting down, which is an
    // ordinary event rather than a provider problem.
    const failure = classifyTransportError(new Error('aborted'), true);

    expect(failure.code).toBe('provider_aborted');
    expect(failure.classification).toBe('RETRYABLE');
  });

  it('recognises a timeout by its error name', () => {
    class TimeoutError extends Error {
      public override readonly name = 'TimeoutError';
    }

    expect(classifyTransportError(new TimeoutError('timed out'), false).code).toBe(
      'provider_timeout',
    );
  });

  it('separates a refused connection from a connection that was lost', () => {
    // The distinction decides whether a fail-closed tenant's notification is
    // retried or stopped: nothing was written to a refused socket, so the
    // message certainly was not sent.
    const refused = classifyTransportError(
      new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }),
      false,
    );

    expect(refused.code).toBe('provider_unreachable');
    expect(hasUnknownOutcome(refused)).toBe(false);
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])(
    'treats %s as never having reached the provider',
    (systemCode) => {
      const failure = classifyTransportError(
        new TypeError('fetch failed', { cause: { code: systemCode } }),
        false,
      );

      expect(failure.code).toBe('provider_unreachable');
    },
  );

  it('treats a reset connection as an unknown outcome', () => {
    const failure = classifyTransportError(
      new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }),
      false,
    );

    expect(failure.code).toBe('provider_connection_lost');
    expect(hasUnknownOutcome(failure)).toBe(true);
  });

  it('treats a transport error with no recognisable cause as an unknown outcome', () => {
    // Failing towards "we cannot tell" is the safe direction: assuming the
    // message was not sent is what produces a duplicate.
    expect(classifyTransportError(new TypeError('fetch failed'), false).code).toBe(
      'provider_connection_lost',
    );
  });

  it('handles a thrown value that is not an Error', () => {
    expect(classifyTransportError('something odd', false).code).toBe('provider_connection_lost');
  });

  it('classifies every transport failure as retryable', () => {
    for (const [error, aborted] of [
      [new Error('boom'), true],
      [new TypeError('fetch failed'), false],
      [new TypeError('refused', { cause: { code: 'ECONNREFUSED' } }), false],
      ['not an error', false],
    ] as const) {
      expect(classifyTransportError(error, aborted).classification).toBe('RETRYABLE');
    }
  });
});

describe('a 422 that is about the session rather than the payload', () => {
  it('is retried, because a disconnected session reconnects on its own', () => {
    // The provider answers 422 for both, so the message is the only signal.
    // Treating this one as permanent throws away a message that would have
    // gone out minutes later — which is what happened when the provider was
    // restarted mid-flight.
    const failure = classifyHttpStatus(422, '{"message":"The session is not connected."}');

    expect(failure.code).toBe('session_not_ready');
    expect(failure.classification).toBe('RETRYABLE');
  });

  it('covers the other words the provider uses for the same state', () => {
    const messages = [
      'The session is not ready',
      'session status is not WORKING',
      'The session is starting',
      'Session is stopped',
      'The session needs to scan a code',
    ];

    for (const message of messages) {
      expect(classifyHttpStatus(422, message).code).toBe('session_not_ready');
    }
  });

  it('leaves a payload rejection permanent, because it will be rejected again', () => {
    const failure = classifyHttpStatus(422, 'chatId is required');

    expect(failure.code).toBe('provider_invalid_request');
    expect(failure.classification).toBe('PERMANENT');
  });
});
