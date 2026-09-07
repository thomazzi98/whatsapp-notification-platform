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
 * next time.
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

export function classifyHttpStatus(
  status: number,
  message: string,
  headers?: Headers,
): ProviderFailure {
  const code = codeByStatus[status] ?? 'provider_unknown_error';
  const retryAfterSeconds = readRetryAfterSeconds(headers);

  return createProviderFailure(code, message, {
    providerStatusCode: status,
    ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
  });
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
 * A transport error carries no status, so the cause has to be read from the
 * error itself. An abort is separated from a genuine timeout because the worker
 * aborts in-flight requests during shutdown, and that is an ordinary event
 * rather than a provider problem — but both leave the send outcome unknown.
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
  return createProviderFailure('provider_unreachable', message);
}
