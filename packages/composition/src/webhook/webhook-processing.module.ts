import { Module } from '@nestjs/common';

import { ConnectionLimitsModule } from '../whatsapp/connection-limits.module';
import { ProcessWebhookService } from './process-webhook.service';

@Module({
  imports: [ConnectionLimitsModule],
  providers: [ProcessWebhookService],
  exports: [ProcessWebhookService],
})
export class WebhookProcessingModule {}
