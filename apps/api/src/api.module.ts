import { type ApplicationConfiguration } from '@platform/configuration';
import {
  AuthenticationModule,
  DatabaseModule,
  NotificationModule,
  ObservabilityModule,
  QueueModule,
  RuntimeModule,
  TenancyModule,
  WebhookIngestionModule,
  WhatsAppProviderModule,
  WhatsAppSessionModule,
} from '@platform/composition';
import { type DynamicModule, Module } from '@nestjs/common';

import { ApiKeysController } from './dashboard-api/api-keys/api-keys.controller';
import { ApplicationsController } from './dashboard-api/applications/applications.controller';
import { AuthenticationController } from './dashboard-api/authentication/authentication.controller';
import { DashboardNotificationsController } from './dashboard-api/notifications/dashboard-notifications.controller';
import { HealthController } from './health/health.controller';
import { CurrentApplicationController } from './public-api/applications/current-application.controller';
import { NotificationsController } from './public-api/notifications/notifications.controller';
import { WhatsAppSessionsController } from './dashboard-api/whatsapp-sessions/whatsapp-sessions.controller';
import { WhatsAppWebhookController } from './public-api/webhooks/whatsapp-webhook.controller';

@Module({})
export class ApiModule {
  public static forConfiguration(configuration: ApplicationConfiguration): DynamicModule {
    return {
      module: this,
      imports: [
        ObservabilityModule.forConfiguration(configuration, { serviceName: 'api' }),
        DatabaseModule.forConfiguration(configuration, { applicationName: 'platform-api' }),
        // The API only sends jobs; the worker is the process that supervises.
        QueueModule.forConfiguration(configuration, { supervise: false }),
        RuntimeModule,
        AuthenticationModule,
        TenancyModule,
        NotificationModule,
        WebhookIngestionModule,
        // The API drives the connection lifecycle, which is the one place it
        // talks to the provider: pairing needs a person, and the worker has no
        // screen to put a code on.
        WhatsAppProviderModule.forConfiguration(configuration),
        WhatsAppSessionModule,
      ],
      controllers: [
        HealthController,
        AuthenticationController,
        ApplicationsController,
        ApiKeysController,
        WhatsAppSessionsController,
        DashboardNotificationsController,
        CurrentApplicationController,
        NotificationsController,
        WhatsAppWebhookController,
      ],
    };
  }
}
