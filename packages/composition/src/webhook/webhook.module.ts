import { Module } from '@nestjs/common';

import { IngestWebhookService } from './ingest-webhook.service';

/**
 * Receiving a callback and acting on it are separate modules for the same
 * reason they are separate processes: the API authenticates and files, and only
 * the worker touches the notification the callback concerns.
 */
@Module({
  providers: [IngestWebhookService],
  exports: [IngestWebhookService],
})
export class WebhookIngestionModule {}
