import { describe, expect, it } from 'vitest';

import {
  classifyFailureCode,
  createProviderFailure,
  isRetryable,
  hasUnknownOutcome,
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

  it('retries an unknown send outcome, which is the platform default', () => {
    // Retrying risks a duplicate and failing risks losing a delivered message.
    // The default answer is to try again; a tenant that prefers the other risk
    // opts into the fail-closed code below.
    expect(classifyFailureCode('provider_outcome_unknown')).toBe('RETRYABLE');
  });

  it('never resends once a tenant has chosen to fail closed', () => {
    expect(classifyFailureCode('unknown_outcome_fail_closed')).toBe('PERMANENT');
  });

  it('retries an unmapped provider error, conservatively', () => {
    expect(classifyFailureCode('provider_unknown_error')).toBe('RETRYABLE');
  });
});

describe('hasUnknownOutcome', () => {
  it('recognises the failures after which a send may still have happened', () => {
    const ambiguous: ProviderFailureCode[] = [
      'provider_timeout',
      'provider_aborted',
      'provider_connection_lost',
      'provider_outcome_unknown',
    ];

    for (const code of ambiguous) {
      expect(hasUnknownOutcome(createProviderFailure(code, 'No answer.')), code).toBe(true);
    }
  });

  it('does not treat a refused connection as ambiguous', () => {
    // Nothing was written to a socket that was never accepted, so the message
    // certainly was not sent. Keeping this distinct is what stops a provider
    // outage from permanently failing a fail-closed tenant's notifications.
    expect(
      hasUnknownOutcome(createProviderFailure('provider_unreachable', 'Connection refused.')),
    ).toBe(false);
  });

  it('does not treat a rejected request as ambiguous', () => {
    for (const code of ['provider_invalid_request', 'provider_rate_limited'] as const) {
      expect(hasUnknownOutcome(createProviderFailure(code, 'Rejected.')), code).toBe(false);
    }
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
