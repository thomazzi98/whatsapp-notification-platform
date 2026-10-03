export const failureModes = [
  'none',
  'server_error',
  'unauthorized',
  'rate_limited',
  'invalid_request',
  'timeout',
  'connection_reset',
  'reachout_timelock',
  'message_capping',
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
  '0463': 'reachout_timelock',
  '0475': 'message_capping',
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

/**
 * What the real server answers when an engine call throws: the error, its
 * stack, and the request that caused it, echoed back. The echo is the point of
 * modelling it — it carries the chat identifier and the message text, which is
 * exactly what must never reach a failure reason the public API returns.
 */
function engineErrorBody(message: string, chatIdentifier: string): Record<string, unknown> {
  return {
    statusCode: 500,
    timestamp: new Date(0).toISOString(),
    exception: {
      message,
      name: 'Error',
      stack: `Error: ${message}\n    at WhatsappSessionWebJS.sendText (/app/dist/core/engines/webjs/session.webjs.core.js:1:1)`,
    },
    request: {
      path: '/api/sendText',
      method: 'POST',
      body: { session: 'default', chatId: chatIdentifier, text: 'The message text' },
    },
  };
}

const responseByMode: Partial<Record<FailureMode, FailureResponse>> = {
  server_error: { statusCode: 500, body: { message: 'Internal engine failure.' } },
  unauthorized: { statusCode: 401, body: { message: 'Unauthorized' } },
  rate_limited: {
    statusCode: 429,
    body: { message: 'Too many requests.' },
    headers: { 'retry-after': RATE_LIMITED_RETRY_AFTER_SECONDS },
  },
  invalid_request: { statusCode: 422, body: { message: 'The request payload is invalid.' } },
  reachout_timelock: {
    statusCode: 500,
    body: engineErrorBody('server returned error 463', '5511999990463@c.us'),
  },
  message_capping: {
    statusCode: 500,
    body: engineErrorBody('server returned error 475', '5511999990475@c.us'),
  },
};

export function responseForFailureMode(mode: FailureMode): FailureResponse | undefined {
  return responseByMode[mode];
}
