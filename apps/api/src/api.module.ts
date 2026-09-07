import { type ApplicationConfiguration } from '@platform/configuration';
import {
  AuthenticationModule,
  DatabaseModule,
  RuntimeModule,
  TenancyModule,
} from '@platform/composition';
import { type DynamicModule, Module } from '@nestjs/common';

import { ApiKeysController } from './dashboard-api/api-keys/api-keys.controller';
import { ApplicationsController } from './dashboard-api/applications/applications.controller';
import { AuthenticationController } from './dashboard-api/authentication/authentication.controller';
import { HealthController } from './health/health.controller';
import { CurrentApplicationController } from './public-api/applications/current-application.controller';

@Module({})
export class ApiModule {
  public static forConfiguration(configuration: ApplicationConfiguration): DynamicModule {
    return {
      module: this,
      imports: [
        DatabaseModule.forConfiguration(configuration),
        RuntimeModule,
        AuthenticationModule,
        TenancyModule,
      ],
      controllers: [
        HealthController,
        AuthenticationController,
        ApplicationsController,
        ApiKeysController,
        CurrentApplicationController,
      ],
    };
  }
}
