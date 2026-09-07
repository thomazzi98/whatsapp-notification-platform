import { runWithCorrelationContext } from '@platform/observability';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

export const CORRELATION_HEADER = 'x-correlation-id';

/** A ULID or a UUID. Anything else is client-supplied noise. */
const ACCEPTABLE_CORRELATION_ID = /^[0-9A-Za-z-]{16,64}$/;

function resolveCorrelationId(request: FastifyRequest): string {
  const supplied = request.headers[CORRELATION_HEADER];
  const candidate = Array.isArray(supplied) ? supplied[0] : supplied;

  // An inbound value is echoed so a caller can correlate across systems, but
  // only after validation: it is written into every log line, and arbitrary
  // client input does not belong there.
  if (typeof candidate === 'string' && ACCEPTABLE_CORRELATION_ID.test(candidate)) {
    return candidate;
  }
  return request.id;
}

/**
 * Opens a correlation scope for the whole request.
 *
 * Registered directly on the Fastify instance rather than as a Nest middleware,
 * so the scope is already open for anything Fastify does before Nest's own
 * pipeline runs.
 */
export function registerCorrelationHook(instance: FastifyInstance, _recipientSalt: string): void {
  instance.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    const correlationId = resolveCorrelationId(request);
    void reply.header(CORRELATION_HEADER, correlationId);

    runWithCorrelationContext({ correlationId, requestId: request.id }, () => {
      done();
    });
  });
}
