import { type FastifyInstance, type FastifyRequest } from 'fastify';

/** Requests under this prefix keep the exact bytes that arrived. */
export const RAW_BODY_PATH_PREFIX = '/webhooks/';

export interface RequestWithRawBody extends FastifyRequest {
  rawBody?: Buffer;
}

export function readRawBody(request: FastifyRequest): Buffer | undefined {
  return (request as RequestWithRawBody).rawBody;
}

interface ParseFailure extends Error {
  statusCode?: number;
}

/**
 * Keeps the raw request body for the webhook routes.
 *
 * A provider signs the bytes it sent. Verifying against a re-serialised object
 * compares a different string — key order and spacing are not preserved by a
 * parse-and-stringify round trip — so the signature would fail for reasons that
 * are impossible to reproduce from the parsed payload.
 *
 * Fastify attaches parsers to an instance rather than a route, so the buffer is
 * retained only for the paths that need it instead of for every JSON request
 * the API serves.
 */
export function registerRawBodyParser(instance: FastifyInstance): void {
  instance.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      if (request.url.startsWith(RAW_BODY_PATH_PREFIX)) {
        (request as RequestWithRawBody).rawBody = body;
      }

      if (body.length === 0) {
        done(null, undefined);
        return;
      }

      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (error: unknown) {
        const failure = error as ParseFailure;
        // Without the status the default handler reports a 500 for what is
        // plainly a malformed request.
        failure.statusCode = 400;
        done(failure, undefined);
      }
    },
  );
}
