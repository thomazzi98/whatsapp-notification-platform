import { Module } from '@nestjs/common';

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
  providers: [DispatchNotificationService, NotificationMaintenanceService],
  exports: [DispatchNotificationService, NotificationMaintenanceService],
})
export class NotificationDeliveryModule {}
