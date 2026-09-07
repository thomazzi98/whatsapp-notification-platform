/**
 * Domain errors carry a stable code rather than an HTTP status.
 *
 * The domain has no opinion about transport; the HTTP layer maps codes to
 * statuses through a single registry, so the same rule surfaces identically
 * through the public API, the dashboard and any future interface.
 */
export const domainErrorCodes = [
  'email_already_registered',
  'invalid_credentials',
  'account_locked',
  'account_disabled',
  'session_expired',
  'registration_disabled',
  'application_slug_taken',
  'application_not_found',
  'api_key_not_found',
  'insufficient_scope',
  'forbidden',
] as const;

export type DomainErrorCode = (typeof domainErrorCodes)[number];

export class DomainError extends Error {
  public readonly code: DomainErrorCode;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: DomainErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
