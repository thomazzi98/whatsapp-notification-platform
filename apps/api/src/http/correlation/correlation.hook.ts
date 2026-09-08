import { logEvents, runWithCorrelationContext } from '@platform/observability';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { type Logger } from 'pino';

export const CORRELATION_HEADER = 'x-correlation-id';

/** A ULID or a UUID. Anything else is client-supplied noise. */
const ACCEPTABLE_CORRELATION_ID = /^[0-9A-Za-z-]{16,64}$/;

/**
 * Probe endpoints, which an orchestrator calls every few seconds. Logging them
 * at info would bury real traffic under a heartbeat.
 */
const PROBE_PATHS = new Set(['/health', '/ready']);

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
 * Opens a correlation scope for the whole request and records how it ended.
 *
 * Registered directly on the Fastify instance rather than as a Nest middleware,
 * so the scope is already open for anything Fastify does before Nest's own
 * pipeline runs — a 404 for an unrouted path is correlated too.
 *
 * The completion line is what makes the correlation identifier useful: it is
 * the first link in the chain that continues through the queue into the worker,
 * so an operator holding a customer's request can follow it all the way to a
 * WhatsApp message identifier.
 */
export function registerCorrelationHook(instance: FastifyInstance, logger: Logger): void {
  instance.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    const correlationId = resolveCorrelationId(request);
    void reply.header(CORRELATION_HEADER, correlationId);

    runWithCorrelationContext({ correlationId, requestId: request.id }, () => {
      done();
    });
  });

  instance.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done) => {
    const level = PROBE_PATHS.has(request.routeOptions.url ?? request.url) ? 'debug' : 'info';

    logger[level](
      {
        event: logEvents.httpRequestCompleted,
        method: request.method,
        // The matched route, not the raw path: identifiers in a URL would make
        // every request its own log dimension and leak them into the stream.
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        durationMilliseconds: reply.elapsedTime,
      },
      'Request completed',
    );
    done();
  });
}
