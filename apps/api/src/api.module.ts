import { type ApplicationConfiguration } from '@platform/configuration';
import { DatabaseModule } from '@platform/composition';
import { type DynamicModule, Module } from '@nestjs/common';

import { HealthController } from './health/health.controller';

@Module({})
export class ApiModule {
  public static forConfiguration(configuration: ApplicationConfiguration): DynamicModule {
    return {
      module: this,
      imports: [DatabaseModule.forConfiguration(configuration)],
      controllers: [HealthController],
    };
  }
}
