import { getCorrelationId } from '@platform/observability';
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
      this.logger.error({ event: 'http.request.failed', error: exception }, problem.detail);
    }

    void reply.status(problem.status).type('application/problem+json').send(problem);
  }
}
