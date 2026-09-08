import { IngestWebhookService, LOGGER } from '@platform/composition';
import { getCorrelationId, logEvents } from '@platform/observability';
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from '@platform/provider-whatsapp';
import { Controller, Headers, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { type Logger } from 'pino';

import { readRawBody } from '../../http/raw-body';

/**
 * Receives provider callbacks.
 *
 * Deliberately outside `/v1`: this endpoint is authenticated by a signature
 * over its body rather than by an API key, and it is called by infrastructure
 * rather than by a customer. Mixing it into the public API would put a route
 * with entirely different authentication behind the same guard.
 */
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly ingestion: IngestWebhookService;
  private readonly logger: Logger;

  public constructor(ingestion: IngestWebhookService, @Inject(LOGGER) logger: Logger) {
    this.ingestion = ingestion;
    this.logger = logger;
  }

  /**
   * Answers 202 for anything it accepts, and does no interpretation.
   *
   * The provider retries whatever is not answered quickly, so the response has
   * to mean "recorded", not "understood". A duplicate is also a success: a
   * redelivery of an event already filed is exactly the case this endpoint
   * exists to make harmless.
   */
  @Post(':whatsAppSessionId')
  @HttpCode(202)
  public async receive(
    @Param('whatsAppSessionId') whatsAppSessionId: string,
    @Headers(WEBHOOK_SIGNATURE_HEADER) signature: string | undefined,
    @Headers(WEBHOOK_TIMESTAMP_HEADER) timestampHeader: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ accepted: boolean }> {
    const rawBody = readRawBody(request);

    if (rawBody === undefined) {
      this.logger.warn(
        { event: logEvents.webhookRejected, reason: 'no body', whatsAppSessionId },
        'A provider callback arrived without a body',
      );
      reply.status(400);
      return { accepted: false };
    }

    const result = await this.ingestion.ingest({
      whatsAppSessionId,
      rawBody,
      signature,
      timestampHeader,
      correlationId: getCorrelationId() ?? request.id,
    });

    this.logger.info(
      { event: result.logEvent, outcome: result.outcome, reason: result.reason, whatsAppSessionId },
      `Provider callback ${result.outcome}`,
    );

    if (result.outcome === 'rejected') {
      // One answer for an unknown session, a missing signature and a wrong one:
      // telling them apart would let a caller discover which sessions exist.
      reply.status(401);
      return { accepted: false };
    }
    if (result.outcome === 'malformed') {
      reply.status(400);
      return { accepted: false };
    }

    return { accepted: true };
  }
}
