import { type ApplicationConfiguration } from '@platform/configuration';
import { createDatabaseConnection, type DatabaseConnection } from '@platform/database';
import { logEvents } from '@platform/observability';
import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type Logger } from 'pino';

import { APPLICATION_CONFIGURATION, DATABASE_CONNECTION, LOGGER } from '../tokens';
import { DatabaseHealthService } from './database-health.service';

@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  public static forConfiguration(
    configuration: ApplicationConfiguration,
    options: { readonly applicationName: string },
  ): DynamicModule {
    return {
      module: this,
      providers: [
        { provide: APPLICATION_CONFIGURATION, useValue: configuration },
        {
          provide: DATABASE_CONNECTION,
          inject: [LOGGER],
          useFactory: (logger: Logger): DatabaseConnection =>
            createDatabaseConnection({
              connectionUrl: configuration.database.applicationUrl,
              maximumPoolSize: configuration.database.maximumPoolSize,
              statementTimeoutMilliseconds: configuration.database.statementTimeoutMilliseconds,
              // Surfaces in pg_stat_activity, so a stuck query can be traced
              // to the process that issued it.
              applicationName: options.applicationName,
              onPoolError: (error) => {
                logger.error(
                  { event: logEvents.healthDependencyDegraded, dependency: 'database', error },
                  'A pooled database client failed',
                );
              },
            }),
        },
        DatabaseHealthService,
      ],
      exports: [APPLICATION_CONFIGURATION, DATABASE_CONNECTION, DatabaseHealthService],
    };
  }

  private readonly connection: DatabaseConnection;

  public constructor(@Inject(DATABASE_CONNECTION) connection: DatabaseConnection) {
    this.connection = connection;
  }

  public async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}
