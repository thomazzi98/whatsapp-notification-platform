import { describe, expect, it } from 'vitest';

import {
  classifyFailureCode,
  createProviderFailure,
  isRetryable,
  type ProviderFailureCode,
  providerFailureCodes,
} from './provider-failure';

describe('failure classification', () => {
  it('classifies every known failure code', () => {
    for (const code of providerFailureCodes) {
      expect(['RETRYABLE', 'PERMANENT'], code).toContain(classifyFailureCode(code));
    }
  });

  it('retries transient transport and provider problems', () => {
    const retryable: ProviderFailureCode[] = [
      'provider_unreachable',
      'provider_timeout',
      'provider_aborted',
      'provider_rate_limited',
      'provider_server_error',
      'recipient_check_failed',
      'session_not_ready',
    ];

    for (const code of retryable) {
      expect(classifyFailureCode(code), code).toBe('RETRYABLE');
    }
  });

  it('never retries a message the provider will always reject', () => {
    const permanent: ProviderFailureCode[] = [
      'provider_invalid_request',
      'recipient_not_on_whatsapp',
      'invalid_recipient',
      'session_missing',
      'session_unavailable',
    ];

    for (const code of permanent) {
      expect(classifyFailureCode(code), code).toBe('PERMANENT');
    }
  });

  it('treats bad platform credentials as permanent, because retrying hides an operator problem', () => {
    expect(classifyFailureCode('provider_unauthorized')).toBe('PERMANENT');
  });

  it('never resends after the provider reported a delivery error', () => {
    // The message was already handed to WhatsApp; resending risks delivering
    // the same notification twice.
    expect(classifyFailureCode('provider_acknowledgement_error')).toBe('PERMANENT');
  });

  it('treats an unknown send outcome as permanent rather than risking a duplicate', () => {
    expect(classifyFailureCode('provider_outcome_unknown')).toBe('PERMANENT');
  });

  it('retries an unmapped provider error, conservatively', () => {
    expect(classifyFailureCode('provider_unknown_error')).toBe('RETRYABLE');
  });
});

describe('createProviderFailure', () => {
  it('derives the classification from the code so the two cannot disagree', () => {
    const failure = createProviderFailure('provider_timeout', 'The request timed out.');

    expect(failure.classification).toBe('RETRYABLE');
    expect(isRetryable(failure)).toBe(true);
  });

  it('carries provider detail for the delivery timeline', () => {
    const failure = createProviderFailure('provider_rate_limited', 'Slow down.', {
      retryAfterSeconds: 30,
      providerStatusCode: 429,
    });

    expect(failure.retryAfterSeconds).toBe(30);
    expect(failure.providerStatusCode).toBe(429);
  });

  it('reports a permanent failure as not retryable', () => {
    expect(
      isRetryable(createProviderFailure('recipient_not_on_whatsapp', 'Not on WhatsApp.')),
    ).toBe(false);
  });
});
