import { type ApplicationConfiguration } from '@platform/configuration';
import {
  DatabaseModule,
  NotificationDeliveryModule,
  QueueModule,
  RuntimeModule,
  WhatsAppProviderModule,
} from '@platform/composition';
import { type DynamicModule, Module } from '@nestjs/common';

import { JobRunnerService } from './jobs/job-runner.service';
import { NotificationDispatchHandler } from './jobs/notification-dispatch.handler';
import { NotificationMaintenanceHandler } from './jobs/notification-maintenance.handler';

@Module({})
export class WorkerModule {
  public static forConfiguration(configuration: ApplicationConfiguration): DynamicModule {
    return {
      module: this,
      imports: [
        DatabaseModule.forConfiguration(configuration, { applicationName: 'platform-worker' }),
        // The worker is the process that maintains the queue tables and owns
        // the cron schedules. Running that in more than one place would have
        // two processes competing to archive the same jobs.
        QueueModule.forConfiguration(configuration, { supervise: true }),
        RuntimeModule,
        WhatsAppProviderModule.forConfiguration(configuration),
        NotificationDeliveryModule,
      ],
      providers: [NotificationDispatchHandler, NotificationMaintenanceHandler, JobRunnerService],
    };
  }
}
