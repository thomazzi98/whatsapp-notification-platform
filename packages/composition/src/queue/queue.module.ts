import { type ApplicationConfiguration } from '@platform/configuration';
import { createQueueClient } from '@platform/queue';
import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type PgBoss } from 'pg-boss';

import { logEvents } from '@platform/observability';
import { type Logger } from 'pino';

import { APPLICATION_CONFIGURATION, LOGGER, QUEUE_CLIENT } from '../tokens';
import { QueueHealthService } from './queue-health.service';

@Global()
@Module({})
export class QueueModule implements OnApplicationShutdown {
  /**
   * `supervise` decides whether this process maintains the queue tables and
   * runs the cron schedules. Only the worker does; the API constructs a client
   * purely to send, so two processes never both maintain the same tables.
   */
  public static forConfiguration(
    configuration: ApplicationConfiguration,
    options: { readonly supervise: boolean },
  ): DynamicModule {
    return {
      module: this,
      providers: [
        {
          provide: QUEUE_CLIENT,
          inject: [LOGGER],
          useFactory: async (logger: Logger): Promise<PgBoss> => {
            const client = createQueueClient({
              connectionUrl: configuration.database.systemUrl,
              schema: configuration.queue.schema,
              supervise: options.supervise,
              onError: (error) => {
                logger.error(
                  { event: logEvents.healthDependencyDegraded, dependency: 'queue', error },
                  'The queue client reported a failure',
                );
              },
            });
            await client.start();
            return client;
          },
        },
        QueueHealthService,
      ],
      exports: [QUEUE_CLIENT, QueueHealthService],
    };
  }

  private readonly queue: PgBoss;
  private readonly configuration: ApplicationConfiguration;

  public constructor(
    @Inject(QUEUE_CLIENT) queue: PgBoss,
    @Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration,
  ) {
    this.queue = queue;
    this.configuration = configuration;
  }

  public async onApplicationShutdown(): Promise<void> {
    // Graceful: stop accepting new work and let in-flight handlers finish. A
    // job still running when the timeout expires is not lost — its claim is
    // reaped and the notification is dispatched again.
    await this.queue.stop({
      graceful: true,
      timeout: this.configuration.queue.shutdownTimeoutSeconds * 1000,
    });
  }
}
