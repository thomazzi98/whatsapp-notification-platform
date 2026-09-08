import { LOGGER, ProcessWebhookService } from '@platform/composition';
import { logEvents, runWithCorrelationContext } from '@platform/observability';
import { webhookProcessPayloadSchema } from '@platform/queue';
import { Inject, Injectable } from '@nestjs/common';
import { type Job } from 'pg-boss';
import { type Logger } from 'pino';

@Injectable()
export class WebhookProcessHandler {
  private readonly processor: ProcessWebhookService;
  private readonly logger: Logger;

  public constructor(processor: ProcessWebhookService, @Inject(LOGGER) logger: Logger) {
    this.processor = processor;
    this.logger = logger;
  }

  /**
   * Applies one recorded provider callback.
   *
   * An acknowledgement can legitimately arrive before the send it describes has
   * committed, so the service throws in that window and lets the queue retry.
   * That is the only failure here that is expected rather than exceptional.
   */
  public async handle(job: Job<unknown>): Promise<void> {
    const payload = webhookProcessPayloadSchema.safeParse(job.data);

    if (!payload.success) {
      this.logger.error(
        { event: logEvents.queueJobFailed, jobId: job.id, queue: job.name },
        'Discarding a webhook job whose payload does not match the contract',
      );
      return;
    }

    const { correlationId, webhookDeliveryId } = payload.data;

    await runWithCorrelationContext({ correlationId }, async () => {
      const result = await this.processor.process(webhookDeliveryId);

      this.logger.info(
        {
          event: logEvents.webhookProcessed,
          webhookDeliveryId,
          outcome: result.outcome,
          detail: result.detail,
        },
        `Provider callback ${result.outcome}`,
      );
    });
  }
}
