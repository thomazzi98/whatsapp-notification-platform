export const failureModes = [
  'none',
  'server_error',
  'unauthorized',
  'rate_limited',
  'invalid_request',
  'timeout',
  'connection_reset',
] as const;

export type FailureMode = (typeof failureModes)[number];

export function isFailureMode(candidate: string): candidate is FailureMode {
  return (failureModes as readonly string[]).includes(candidate);
}

/**
 * Recipients whose last four digits select a failure, so a test can provoke a
 * specific provider behaviour just by choosing a number.
 *
 * The control plane can force any mode explicitly; these exist so the common
 * cases need no setup call, which keeps end-to-end tests readable.
 */
const failureByNumberSuffix: Record<string, FailureMode> = {
  '0500': 'server_error',
  '0401': 'unauthorized',
  '0429': 'rate_limited',
  '0422': 'invalid_request',
  '0408': 'timeout',
  '0499': 'connection_reset',
};

/** A recipient that reports as not registered on WhatsApp. */
export const UNREGISTERED_NUMBER_SUFFIX = '0404';

export function failureModeForRecipient(chatIdentifier: string): FailureMode {
  const digits = chatIdentifier.replaceAll(/\D/g, '');
  const suffix = digits.slice(-4);

  return failureByNumberSuffix[suffix] ?? 'none';
}

export function isUnregisteredNumber(phoneNumber: string): boolean {
  return phoneNumber.replaceAll(/\D/g, '').endsWith(UNREGISTERED_NUMBER_SUFFIX);
}

export interface FailureResponse {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
  readonly headers?: Record<string, string>;
}

/**
 * Deliberately longer than the first retry's own backoff ceiling of sixty
 * seconds, so a caller that ignores the header and one that honours it end up
 * scheduling visibly different times. A value inside the backoff window would
 * let both look identical.
 */
const RATE_LIMITED_RETRY_AFTER_SECONDS = '90';

const responseByMode: Partial<Record<FailureMode, FailureResponse>> = {
  server_error: { statusCode: 500, body: { message: 'Internal engine failure.' } },
  unauthorized: { statusCode: 401, body: { message: 'Unauthorized' } },
  rate_limited: {
    statusCode: 429,
    body: { message: 'Too many requests.' },
    headers: { 'retry-after': RATE_LIMITED_RETRY_AFTER_SECONDS },
  },
  invalid_request: { statusCode: 422, body: { message: 'The request payload is invalid.' } },
};

export function responseForFailureMode(mode: FailureMode): FailureResponse | undefined {
  return responseByMode[mode];
}
