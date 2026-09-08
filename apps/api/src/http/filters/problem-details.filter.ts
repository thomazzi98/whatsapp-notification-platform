import { type DomainErrorCode, isDomainError } from '@platform/domain';
import { getCorrelationId, logEvents } from '@platform/observability';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { type FastifyReply } from 'fastify';
import { type Logger } from 'pino';

/**
 * RFC 9457 problem details. Every error response in the platform has this
 * shape, so a client can handle failures structurally instead of by parsing
 * prose.
 */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance?: string;
  readonly correlationId?: string;
  readonly errors?: unknown;
}

const INTERNAL_ERROR_DETAIL =
  'The request could not be completed. Quote the correlation identifier when reporting this.';

interface HttpExceptionBody {
  readonly message?: string | string[];
  readonly error?: string;
  readonly errors?: unknown;
}

/**
 * The single place a domain rule becomes an HTTP status.
 *
 * The domain deliberately has no opinion about transport, so this table is what
 * keeps the same rule surfacing identically through every interface.
 */
const statusByDomainErrorCode: Record<DomainErrorCode, { status: number; title: string }> = {
  email_already_registered: { status: 409, title: 'Conflict' },
  invalid_credentials: { status: 401, title: 'Unauthorized' },
  account_locked: { status: 429, title: 'Too Many Requests' },
  account_disabled: { status: 403, title: 'Forbidden' },
  session_expired: { status: 401, title: 'Unauthorized' },
  registration_disabled: { status: 403, title: 'Forbidden' },
  application_slug_taken: { status: 409, title: 'Conflict' },
  application_not_found: { status: 404, title: 'Not Found' },
  api_key_not_found: { status: 404, title: 'Not Found' },
  insufficient_scope: { status: 403, title: 'Forbidden' },
  forbidden: { status: 403, title: 'Forbidden' },
  invalid_schedule: { status: 422, title: 'Unprocessable Entity' },
  no_whatsapp_session: { status: 409, title: 'Conflict' },
  whatsapp_session_not_found: { status: 404, title: 'Not Found' },
  // The connection is in a state where this action cannot succeed, which is a
  // conflict with its current state rather than a bad request.
  whatsapp_session_not_scannable: { status: 409, title: 'Conflict' },
  // 502, not 500: the platform is working and something it depends on is not,
  // and the difference decides whether an operator looks at this service or at
  // WhatsApp.
  whatsapp_provider_unavailable: { status: 502, title: 'Bad Gateway' },
  notification_not_found: { status: 404, title: 'Not Found' },
  notification_not_cancellable: { status: 409, title: 'Conflict' },
  // Same key, different payload: a client bug that must not be answered with
  // the first request's response.
  idempotency_key_reused: { status: 422, title: 'Unprocessable Entity' },
  // Holding the connection open until the first request finishes has no clean
  // timeout story and hides the concurrency from the client.
  idempotency_key_in_flight: { status: 409, title: 'Conflict' },
  invalid_cursor: { status: 400, title: 'Bad Request' },
};

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger: Logger;
  private readonly documentationBaseUrl: string;

  public constructor(logger: Logger, documentationBaseUrl: string) {
    this.logger = logger;
    this.documentationBaseUrl = documentationBaseUrl;
  }

  private toProblemDetails(
    exception: unknown,
    instance: string | undefined,
    correlationId: string | undefined,
  ): ProblemDetails {
    if (isDomainError(exception)) {
      const mapped = statusByDomainErrorCode[exception.code];

      return {
        type: `${this.documentationBaseUrl}/problems/${exception.code}`,
        title: mapped.title,
        status: mapped.status,
        detail: exception.message,
        instance,
        correlationId,
        errors: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const body: HttpExceptionBody =
        typeof response === 'string' ? { message: response } : response;

      return {
        type: this.problemType(status),
        title: body.error ?? exception.name,
        status,
        detail: Array.isArray(body.message)
          ? body.message.join('; ')
          : (body.message ?? exception.message),
        instance,
        correlationId,
        errors: body.errors,
      };
    }

    // An unrecognised exception must never leak its message or stack to a
    // client: the detail is generic and the correlation identifier is the
    // bridge to the log line that has the real cause.
    return {
      type: this.problemType(500),
      title: 'Internal Server Error',
      status: 500,
      detail: INTERNAL_ERROR_DETAIL,
      instance,
      correlationId,
    };
  }

  private problemType(status: number): string {
    return `${this.documentationBaseUrl}/problems/${String(status)}`;
  }

  public catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const reply = context.getResponse<FastifyReply>();
    const request = context.getRequest<{ url?: string }>();
    const correlationId = getCorrelationId();

    const problem = this.toProblemDetails(exception, request.url, correlationId);

    // Only a genuinely unexpected failure is worth an error-level line; a 4xx
    // is the API working as designed, and logging it at error makes the error
    // stream useless for alerting.
    if (problem.status >= 500) {
      this.logger.error({ event: logEvents.httpRequestFailed, error: exception }, problem.detail);
    }

    void reply.status(problem.status).type('application/problem+json').send(problem);
  }
}
