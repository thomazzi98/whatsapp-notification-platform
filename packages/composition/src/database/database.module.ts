import { type ApplicationConfiguration } from '@platform/configuration';
import { createDatabaseConnection, type DatabaseConnection } from '@platform/database';
import { createLogger, logEvents } from '@platform/observability';
import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { APPLICATION_CONFIGURATION, DATABASE_CONNECTION } from '../tokens';
import { DatabaseHealthService } from './database-health.service';

@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  public static forConfiguration(configuration: ApplicationConfiguration): DynamicModule {
    return {
      module: this,
      providers: [
        { provide: APPLICATION_CONFIGURATION, useValue: configuration },
        {
          provide: DATABASE_CONNECTION,
          useFactory: (): DatabaseConnection => {
            const logger = createLogger({
              serviceName: 'database',
              level: configuration.observability.logLevel,
              format: configuration.observability.logFormat,
              nodeEnvironment: configuration.nodeEnvironment,
            });

            return createDatabaseConnection({
              connectionUrl: configuration.database.applicationUrl,
              maximumPoolSize: configuration.database.maximumPoolSize,
              statementTimeoutMilliseconds: configuration.database.statementTimeoutMilliseconds,
              applicationName: 'platform-api',
              onPoolError: (error) => {
                logger.error(
                  { event: logEvents.healthDependencyDegraded, dependency: 'database', error },
                  'A pooled database client failed',
                );
              },
            });
          },
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
