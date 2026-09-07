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

import { QUEUE_CLIENT } from '../tokens';

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
          useFactory: async (): Promise<PgBoss> => {
            const client = createQueueClient({
              connectionUrl: configuration.database.systemUrl,
              schema: configuration.queue.schema,
              supervise: options.supervise,
            });
            await client.start();
            return client;
          },
        },
      ],
      exports: [QUEUE_CLIENT],
    };
  }

  private readonly queue: PgBoss;

  public constructor(@Inject(QUEUE_CLIENT) queue: PgBoss) {
    this.queue = queue;
  }

  public async onApplicationShutdown(): Promise<void> {
    // Graceful: stop accepting new work, let in-flight handlers finish.
    await this.queue.stop({ graceful: true, timeout: 30_000 });
  }
}
