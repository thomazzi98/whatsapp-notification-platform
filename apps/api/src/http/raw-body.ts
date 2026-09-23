import { BadRequestException } from '@nestjs/common';
import { type FastifyInstance, type FastifyRequest } from 'fastify';

/** Requests under this prefix keep the exact bytes that arrived. */
export const RAW_BODY_PATH_PREFIX = '/webhooks/';

export interface RequestWithRawBody extends FastifyRequest {
  rawBody?: Buffer;
}

export function readRawBody(request: FastifyRequest): Buffer | undefined {
  return (request as RequestWithRawBody).rawBody;
}

/**
 * JSON is UTF-8 by definition (RFC 8259). Decoding leniently replaced every
 * invalid byte with U+FFFD, so a client with an encoding bug -- a Windows
 * terminal passing accented text through its ANSI code page, for one -- got a
 * 202 and its recipient got "notifica��es". Refusing the request puts the bug
 * in front of the developer who can fix it instead of the customer who cannot.
 */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function decodeStrictly(body: Buffer): string | undefined {
  try {
    return strictUtf8.decode(body);
  } catch {
    return undefined;
  }
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
  // Fastify's own parser does the parsing, for what it refuses: a body carrying
  // __proto__ or constructor.prototype. Replacing it with a bare JSON.parse, as
  // this used to, quietly dropped that protection.
  const parseJson = instance.getDefaultJsonParser('error', 'error');

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

      const text = decodeStrictly(body);
      if (text === undefined) {
        // An HTTP exception rather than an Error carrying a status: Nest only
        // translates a SyntaxError on its own, and hands anything else to the
        // filter, which reports it as the 500 it looks like.
        done(
          new BadRequestException(
            'The request body is not valid UTF-8. Send JSON encoded as UTF-8.',
          ),
          undefined,
        );
        return;
      }

      // Typed as possibly asynchronous; Fastify's default parser reports
      // through `done` and returns nothing.
      void parseJson(request, text, done);
    },
  );
}
