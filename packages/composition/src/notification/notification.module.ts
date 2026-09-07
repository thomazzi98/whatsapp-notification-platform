import { Module } from '@nestjs/common';

import { CreateNotificationService } from './create-notification.service';
import { NotificationQueryService } from './notification-query.service';

@Module({
  providers: [CreateNotificationService, NotificationQueryService],
  exports: [CreateNotificationService, NotificationQueryService],
})
export class NotificationModule {}
