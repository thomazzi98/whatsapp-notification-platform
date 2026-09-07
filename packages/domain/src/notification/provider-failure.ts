export const failureClassifications = ['RETRYABLE', 'PERMANENT'] as const;

export type FailureClassification = (typeof failureClassifications)[number];

export const providerFailureCodes = [
  'provider_unreachable',
  'provider_timeout',
  'provider_aborted',
  'provider_rate_limited',
  'provider_server_error',
  'provider_unauthorized',
  'provider_invalid_request',
  'provider_unknown_error',
  'session_missing',
  'session_not_ready',
  'session_unavailable',
  'recipient_not_on_whatsapp',
  'recipient_check_failed',
  'invalid_recipient',
  'provider_acknowledgement_error',
  'provider_outcome_unknown',
  'maximum_attempts_exhausted',
] as const;

export type ProviderFailureCode = (typeof providerFailureCodes)[number];

export interface ProviderFailure {
  readonly code: ProviderFailureCode;
  readonly classification: FailureClassification;
  readonly message: string;
  readonly retryAfterSeconds?: number;
  readonly providerStatusCode?: number;
}

/**
 * The single table mapping a failure to what the platform does about it.
 *
 * Two entries deserve explanation. `provider_unauthorized` is permanent and
 * operator-actionable: it means the platform's own WAHA credentials are wrong,
 * so every send will fail until a human fixes it, and retrying only hides that.
 * `provider_acknowledgement_error` is permanent because the message was already
 * handed to WhatsApp — resending could deliver it twice.
 */
const classificationByCode: Record<ProviderFailureCode, FailureClassification> = {
  provider_unreachable: 'RETRYABLE',
  provider_timeout: 'RETRYABLE',
  provider_aborted: 'RETRYABLE',
  provider_rate_limited: 'RETRYABLE',
  provider_server_error: 'RETRYABLE',
  provider_unknown_error: 'RETRYABLE',
  session_not_ready: 'RETRYABLE',
  recipient_check_failed: 'RETRYABLE',

  provider_unauthorized: 'PERMANENT',
  provider_invalid_request: 'PERMANENT',
  session_missing: 'PERMANENT',
  session_unavailable: 'PERMANENT',
  recipient_not_on_whatsapp: 'PERMANENT',
  invalid_recipient: 'PERMANENT',
  provider_acknowledgement_error: 'PERMANENT',
  provider_outcome_unknown: 'PERMANENT',
  maximum_attempts_exhausted: 'PERMANENT',
};

export function classifyFailureCode(code: ProviderFailureCode): FailureClassification {
  return classificationByCode[code];
}

export function isRetryable(failure: ProviderFailure): boolean {
  return failure.classification === 'RETRYABLE';
}

export function createProviderFailure(
  code: ProviderFailureCode,
  message: string,
  details: { readonly retryAfterSeconds?: number; readonly providerStatusCode?: number } = {},
): ProviderFailure {
  return {
    code,
    classification: classifyFailureCode(code),
    message,
    ...details,
  };
}
