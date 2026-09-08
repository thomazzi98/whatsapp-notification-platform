import { type ApplicationConfiguration } from '@platform/configuration';
import {
  APPLICATION_CONFIGURATION,
  type DispatchResult,
  DispatchNotificationService,
} from '@platform/composition';
import { createLogger, logEvents, runWithCorrelationContext } from '@platform/observability';
import { notificationDispatchPayloadSchema } from '@platform/queue';
import { Inject, Injectable } from '@nestjs/common';
import { type Logger } from 'pino';
import { type Job } from 'pg-boss';

const logEventByOutcome: Record<DispatchResult['outcome'], string> = {
  sent: logEvents.notificationDispatchSucceeded,
  retry_scheduled: logEvents.notificationDispatchRetrying,
  failed: logEvents.notificationDispatchFailed,
  deferred: logEvents.notificationDispatchPaced,
  not_claimable: logEvents.notificationClaimSkipped,
};

@Injectable()
export class NotificationDispatchHandler {
  private readonly dispatcher: DispatchNotificationService;
  private readonly logger: Logger;

  public constructor(
    dispatcher: DispatchNotificationService,
    @Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration,
  ) {
    this.dispatcher = dispatcher;
    this.logger = createLogger({
      serviceName: 'worker',
      level: configuration.observability.logLevel,
      format: configuration.observability.logFormat,
      nodeEnvironment: configuration.nodeEnvironment,
    });
  }

  /**
   * Handles one dispatch job.
   *
   * A malformed payload is discarded rather than retried: it will be exactly as
   * malformed on the next attempt, and failing it repeatedly only fills the
   * dead letter queue with the same message. Anything else that throws is
   * genuinely unexpected and is allowed to propagate, so the queue retries it
   * and the job eventually dead-letters where an operator can see it.
   */
  public async handle(job: Job<unknown>): Promise<void> {
    const payload = notificationDispatchPayloadSchema.safeParse(job.data);

    if (!payload.success) {
      this.logger.error(
        { event: logEvents.queueJobFailed, jobId: job.id, queue: job.name },
        'Discarding a dispatch job whose payload does not match the contract',
      );
      return;
    }

    const { correlationId, notificationId, applicationId } = payload.data;

    await runWithCorrelationContext({ correlationId, notificationId, applicationId }, async () => {
      const startedAt = process.hrtime.bigint();

      this.logger.debug(
        { event: logEvents.notificationDispatchStarted, jobId: job.id },
        'Dispatching a notification',
      );

      const result = await this.dispatcher.dispatch({
        applicationId,
        notificationId,
        correlationId,
        // pg-boss aborts this when the job expires or the worker is stopping,
        // so an in-flight WhatsApp request does not outlive its own job.
        abortSignal: job.signal,
      });

      this.logger.info(
        {
          event: logEventByOutcome[result.outcome],
          outcome: result.outcome,
          detail: result.detail,
          durationMilliseconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        },
        `Dispatch finished: ${result.outcome}`,
      );
    });
  }
}
