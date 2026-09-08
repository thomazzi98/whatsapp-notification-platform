import { type ApplicationConfiguration } from '@platform/configuration';
import { createLogger } from '@platform/observability';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { type Logger } from 'pino';

import { LOGGER } from '../tokens';

/**
 * One logger per process, injected rather than constructed.
 *
 * Every call site that built its own was configuring the redaction rules again
 * from scratch, which is precisely the setting that must not vary: a logger
 * created without them writes customer phone numbers to stdout.
 */
@Global()
@Module({})
export class ObservabilityModule {
  public static forConfiguration(
    configuration: ApplicationConfiguration,
    options: { readonly serviceName: string },
  ): DynamicModule {
    return {
      module: this,
      providers: [
        {
          provide: LOGGER,
          useFactory: (): Logger =>
            createLogger({
              serviceName: options.serviceName,
              level: configuration.observability.logLevel,
              format: configuration.observability.logFormat,
              nodeEnvironment: configuration.nodeEnvironment,
            }),
        },
      ],
      exports: [LOGGER],
    };
  }
}
