import {
  createProviderFailure,
  type ProviderFailure,
  type ProviderFailureCode,
} from '@platform/domain';

/**
 * Maps what actually came back from the provider to what the platform should do
 * about it.
 *
 * The distinction that matters is retryable versus permanent, because it
 * decides whether a customer's notification is attempted again or reported as
 * failed. Two entries deserve their reasoning stated: an unauthorized response
 * means the platform's own credentials are wrong, so every send will fail until
 * an operator fixes it and retrying only hides that; and a 422 means the
 * payload the platform built was rejected, which will be rejected identically
 * next time -- unless it is about the session, see below.
 */
const codeByStatus: Record<number, ProviderFailureCode> = {
  401: 'provider_unauthorized',
  403: 'provider_unauthorized',
  404: 'session_missing',
  422: 'provider_invalid_request',
  429: 'provider_rate_limited',
  500: 'provider_server_error',
  502: 'provider_server_error',
  503: 'provider_server_error',
  504: 'provider_server_error',
};

const RETRY_AFTER_HEADER = 'retry-after';

/**
 * The one 422 that is not about the payload.
 *
 * WAHA answers 422 both for a request it cannot parse and for a session that
 * is not connected, and those need opposite treatment: the first will be
 * rejected identically forever, the second fixes itself the moment the phone
 * reconnects. Treating the second as permanent throws away a message that
 * would have gone out minutes later.
 *
 * Matching on the message is unpleasant and it is the only signal there is —
 * the status is identical. It fails safe: anything this does not recognise
 * stays permanent, which is the behaviour it had before.
 *
 * Found by restarting the provider mid-flight, which left the platform's
 * record of the session saying WORKING while the provider had forgotten it.
 */
const SESSION_STATE_PATTERN =
  /session.*(not connected|not ready|not working|starting|stopped|scan)/i;

export function classifyHttpStatus(
  status: number,
  message: string,
  headers?: Headers,
): ProviderFailure {
  const code = readCode(status, message);
  const retryAfterSeconds = readRetryAfterSeconds(headers);

  return createProviderFailure(code, message, {
    providerStatusCode: status,
    ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
  });
}

function readCode(status: number, message: string): ProviderFailureCode {
  if (status === 422 && SESSION_STATE_PATTERN.test(message)) {
    return 'session_not_ready';
  }
  return codeByStatus[status] ?? 'provider_unknown_error';
}

function readRetryAfterSeconds(headers: Headers | undefined): number | undefined {
  const raw = headers?.get(RETRY_AFTER_HEADER)?.trim();
  if (raw === undefined || raw === null || raw.length === 0) {
    return undefined;
  }

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return seconds;
}

const ABORT_ERROR_NAMES = new Set(['AbortError', 'TimeoutError']);

/**
 * Socket errors that happen before any byte of the request is written. A
 * refused connection, an unresolvable name or an unroutable host all mean the
 * provider was never reached, so the message certainly was not sent.
 *
 * Everything else — a reset, a broken pipe, a socket closing mid-response — is
 * ambiguous, and the difference matters: it decides whether a fail-closed
 * tenant's notification is retried or stopped.
 */
const PRE_CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function readSystemErrorCode(error: unknown): string | undefined {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];

  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) {
      continue;
    }
    const code = (candidate as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}

/**
 * A transport error carries no status, so the cause has to be read from the
 * error itself. An abort is separated from a genuine timeout because the worker
 * aborts in-flight requests during shutdown, and that is an ordinary event
 * rather than a provider problem.
 */
export function classifyTransportError(error: unknown, wasAborted: boolean): ProviderFailure {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : 'The provider request failed.';

  if (wasAborted) {
    return createProviderFailure('provider_aborted', message);
  }
  if (ABORT_ERROR_NAMES.has(name)) {
    return createProviderFailure('provider_timeout', message);
  }

  const systemCode = readSystemErrorCode(error);
  if (systemCode !== undefined && PRE_CONNECTION_ERROR_CODES.has(systemCode)) {
    return createProviderFailure('provider_unreachable', message);
  }
  return createProviderFailure('provider_connection_lost', message);
}
