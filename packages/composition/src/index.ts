// Record shapes are part of the contract of the services that return them, so
// applications import them from here rather than reaching into the persistence
// adapter directly.
export type { RateLimitPolicy } from '@platform/database';
export type {
  ApiKeyRecord,
  ApplicationRecord,
  NotificationEventRecord,
  NotificationRecord,
  WhatsAppSessionRecord,
} from '@platform/database';
export {
  type AuthenticatedPrincipal,
  AuthenticationService,
  type EstablishedSession,
  type LoginInput,
  type RegisterInput,
} from './authentication/authentication.service';
export { AuthenticationModule } from './authentication/authentication.module';
export {
  DatabaseHealthService,
  type DependencyCheckResult,
} from './database/database-health.service';
export { DatabaseModule } from './database/database.module';
export {
  type CreateNotificationInput,
  type CreateNotificationResult,
  CreateNotificationService,
} from './notification/create-notification.service';
export {
  type DispatchInput,
  DispatchNotificationService,
  type DispatchOutcome,
  dispatchOutcomes,
  type DispatchResult,
} from './notification/dispatch-notification.service';
export {
  type MaintenanceReport,
  NotificationMaintenanceService,
} from './notification/notification-maintenance.service';
export { NotificationDeliveryModule } from './notification/notification-delivery.module';
export { NotificationModule } from './notification/notification.module';
export {
  type NotificationListQuery,
  type NotificationListResult,
  NotificationQueryService,
} from './notification/notification-query.service';
export { WhatsAppProviderModule } from './provider/whatsapp-provider.module';
export { QueueHealthService } from './queue/queue-health.service';
export { QueueModule } from './queue/queue.module';
export { RateLimitModule } from './rate-limit/rate-limit.module';
export {
  type RateLimitOutcome,
  RateLimitService,
  registrationPolicy,
  signInPolicy,
} from './rate-limit/rate-limit.service';
export { RuntimeModule } from './runtime/runtime.module';
export { type ApiKeyPrincipal, ApiKeyService, type CreatedApiKey } from './tenancy/api-key.service';
export { ApplicationService } from './tenancy/application.service';
export { TenancyModule } from './tenancy/tenancy.module';
export { ObservabilityModule } from './observability/observability.module';
export { APPLICATION_CONFIGURATION, DATABASE_CONNECTION, LOGGER, QUEUE_CLIENT } from './tokens';
export {
  type IngestWebhookInput,
  type IngestWebhookResult,
  IngestWebhookService,
  type WebhookIngestionOutcome,
  webhookIngestionOutcomes,
} from './webhook/ingest-webhook.service';
export {
  type ProcessWebhookResult,
  ProcessWebhookService,
} from './webhook/process-webhook.service';
// The two header names the provider signs its callbacks with. An application
// has to read them off the request; reaching into the adapter for a string is
// what the layering forbids, so they are re-exported here with everything else
// the applications may know about the provider.
export { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from '@platform/provider-whatsapp';
export { WebhookProcessingModule } from './webhook/webhook-processing.module';
export { WebhookIngestionModule } from './webhook/webhook.module';
export {
  type CreateWhatsAppSessionInput,
  WhatsAppSessionService,
} from './whatsapp/whatsapp-session.service';
export { WhatsAppSessionModule } from './whatsapp/whatsapp.module';
