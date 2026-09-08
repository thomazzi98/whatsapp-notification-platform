import { Module } from '@nestjs/common';

import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { DispatchNotificationService } from './dispatch-notification.service';
import { NotificationMaintenanceService } from './notification-maintenance.service';

/**
 * Delivery is a separate module from notification creation because only the
 * worker performs it.
 *
 * Keeping them together would oblige the API to wire a WhatsApp provider it
 * never calls, and would put a class capable of sending messages inside the
 * process that handles untrusted requests.
 */
@Module({
  // Imported even though the module is global: maintenance prunes the limiter's
  // buckets, and a module that consumes a service should not depend on some
  // other module having registered it first.
  imports: [RateLimitModule],
  providers: [DispatchNotificationService, NotificationMaintenanceService],
  exports: [DispatchNotificationService, NotificationMaintenanceService],
})
export class NotificationDeliveryModule {}
