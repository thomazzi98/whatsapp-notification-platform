import { Module } from '@nestjs/common';

import { ProcessWebhookService } from './process-webhook.service';

@Module({
  providers: [ProcessWebhookService],
  exports: [ProcessWebhookService],
})
export class WebhookProcessingModule {}
