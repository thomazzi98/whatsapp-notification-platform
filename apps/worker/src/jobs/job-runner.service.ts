import { type ApplicationConfiguration } from '@platform/configuration';
import { APPLICATION_CONFIGURATION, QUEUE_CLIENT } from '@platform/composition';
import { createLogger, logEvents } from '@platform/observability';
import { queueNames } from '@platform/queue';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { type Job, type JobResult, type PgBoss } from 'pg-boss';
import { type Logger } from 'pino';

import { NotificationDispatchHandler } from './notification-dispatch.handler';
import { NotificationMaintenanceHandler } from './notification-maintenance.handler';

/**
 * How often the repair pass runs.
 *
 * A minute is short enough that a worker killed mid-send is noticed while
 * someone is still watching the deployment, and long enough that the scan costs
 * nothing on an idle system.
 */
const MAINTENANCE_CRON = '* * * * *';

/**
 * Subscribes the process to its queues.
 *
 * Kept apart from the handlers so that starting and stopping the subscriptions
 * is one concern in one place: the handlers know how to do the work and nothing
 * about how they are invoked.
 */
@Injectable()
export class JobRunnerService implements OnApplicationBootstrap {
  private readonly queue: PgBoss;
  private readonly configuration: ApplicationConfiguration;
  private readonly dispatch: NotificationDispatchHandler;
  private readonly maintenance: NotificationMaintenanceHandler;
  private readonly logger: Logger;

  public constructor(
    @Inject(QUEUE_CLIENT) queue: PgBoss,
    @Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration,
    dispatch: NotificationDispatchHandler,
    maintenance: NotificationMaintenanceHandler,
  ) {
    this.queue = queue;
    this.configuration = configuration;
    this.dispatch = dispatch;
    this.maintenance = maintenance;
    this.logger = createLogger({
      serviceName: 'worker',
      level: configuration.observability.logLevel,
      format: configuration.observability.logFormat,
      nodeEnvironment: configuration.nodeEnvironment,
    });
  }

  /**
   * A dead-lettered notification has exhausted the queue's own retries without
   * the handler ever completing, which means something is wrong with the worker
   * rather than with the message. It is recorded loudly and left alone: pg-boss
   * keeps the job, so an operator can inspect and redrive it.
   */
  private recordDeadLetters(jobs: Job<unknown>[]): void {
    for (const job of jobs) {
      this.logger.error(
        { event: logEvents.notificationDeadLettered, jobId: job.id, payload: job.data },
        'A notification dispatch job was dead lettered',
      );
    }
  }

  public async onApplicationBootstrap(): Promise<void> {
    await this.subscribe();
  }

  public async subscribe(): Promise<void> {
    await this.queue.work(
      queueNames.notificationDispatch,
      {
        batchSize: this.configuration.queue.concurrency,
        pollingIntervalSeconds: this.configuration.queue.pollingIntervalSeconds,
        // Each notification is settled on its own. Without this a single
        // failure would fail every job in the batch, so one unlucky message
        // would drag four healthy ones into a needless retry.
        perJobResults: true,
      },
      (jobs: Job<unknown>[]) => this.runBatch(jobs),
    );

    await this.queue.work(
      queueNames.notificationDeadLetter,
      { batchSize: 10, pollingIntervalSeconds: 60 },
      (jobs: Job<unknown>[]) => {
        this.recordDeadLetters(jobs);

        return Promise.resolve();
      },
    );

    await this.queue.work(
      queueNames.maintenanceReconcile,
      { batchSize: 1, pollingIntervalSeconds: 30 },
      () => this.maintenance.handle(),
    );

    // Idempotent: pg-boss keys a schedule by queue name, so a restart replaces
    // the existing entry rather than adding a second one.
    await this.queue.schedule(queueNames.maintenanceReconcile, MAINTENANCE_CRON);

    this.logger.info(
      { event: logEvents.queueJobStarted, concurrency: this.configuration.queue.concurrency },
      'Worker subscribed to its queues',
    );
  }

  /**
   * Settles every job in a batch on its own.
   *
   * pg-boss hands the handler an array, and the obvious implementation — await
   * them in sequence and let the first rejection escape — fails the whole
   * batch. One notification hitting a permanent provider error would then drag
   * four healthy ones into a retry they did not need.
   */
  public async runBatch(jobs: Job<unknown>[]): Promise<JobResult[]> {
    const settled = await Promise.allSettled(jobs.map((job) => this.dispatch.handle(job)));

    return settled.map((outcome, index) => {
      const job = jobs[index];
      const id = job?.id ?? '';

      if (outcome.status === 'fulfilled') {
        return { id, status: 'completed' };
      }

      this.logger.error(
        { event: logEvents.queueJobFailed, jobId: id, error: outcome.reason },
        'A dispatch job threw and will be retried',
      );

      return { id, status: 'failed' };
    });
  }
}
