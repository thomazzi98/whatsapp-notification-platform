export { DomainError, type DomainErrorCode, domainErrorCodes, isDomainError } from './errors';
export {
  type DeliveryAcknowledgement,
  deliveryAcknowledgements,
  describeAcknowledgement,
  isDeliveredAcknowledgement,
  isFailureAcknowledgement,
  isReadAcknowledgement,
  isDeliveryAcknowledgement,
  mergeAcknowledgements,
} from './notification/delivery-acknowledgement';
export {
  assertNotificationStatusTransition,
  cancellableNotificationStatuses,
  canTransitionNotificationStatus,
  IllegalNotificationStatusTransitionError,
  isCancellableNotificationStatus,
  isNotificationStatus,
  isTerminalNotificationStatus,
  type NotificationStatus,
  notificationStatuses,
  notificationStatusTransitions,
  type TerminalNotificationStatus,
  terminalNotificationStatuses,
} from './notification/notification-status';
export {
  classifyFailureCode,
  createProviderFailure,
  type FailureClassification,
  failureClassifications,
  isRetryable,
  hasUnknownOutcome,
  type ProviderFailure,
  type ProviderFailureCode,
  providerFailureCodes,
} from './notification/provider-failure';
export {
  computeNextAttemptAt,
  computeRetryDelaySeconds,
  defaultRetryPolicy,
  type RetryPolicy,
  sessionNotReadyMinimumDelaySeconds,
} from './notification/retry-policy';
export { type ProviderEvent, toDeliveryAcknowledgement } from './provider/provider-event';
export { normalizeProviderMessageId } from './provider/provider-message-id';
export {
  canSessionSend,
  type CreateSessionInput,
  failed,
  isProviderSessionStatus,
  type ProviderQrCode,
  type ProviderResult,
  type ProviderSession,
  type ProviderSessionStatus,
  providerSessionStatuses,
  type ResolvedRecipient,
  type SendTextMessageInput,
  type SentMessage,
  succeeded,
  toProviderSessionStatus,
  WHATSAPP_PROVIDER_PORT,
  type WhatsAppProviderPort,
} from './provider/whatsapp-provider.port';
export { CLOCK_PORT, type ClockPort } from './ports/clock';
export {
  IDENTIFIER_GENERATOR_PORT,
  type IdentifierGeneratorPort,
} from './ports/identifier-generator';
export { RANDOM_PORT, type RandomPort } from './ports/random';
export {
  InvalidPhoneNumberError,
  isValidPhoneNumber,
  maskPhoneNumberForLog,
  normalizePhoneNumber,
  parsePhoneNumber,
} from './recipient/phone-number';
export {
  type ParsedTemplate,
  parseTemplate,
  type TemplateNode,
  TemplateSyntaxError,
  type TemplateSyntaxErrorCode,
  templateSyntaxErrorCodes,
  templateVariableNamePattern,
} from './template/parse-template';
export {
  maximumRenderedBodyLength,
  maximumVariableValueLength,
  type RenderResult,
  renderTemplate,
  TemplateRenderError,
  type TemplateRenderErrorCode,
  templateRenderErrorCodes,
  type TemplateRenderErrorDetails,
  type TemplateVariableDeclaration,
  type TemplateVariableValue,
} from './template/render-template';
export {
  apiKeyDisplayPrefix,
  type ApiKeyEnvironment,
  apiKeyEnvironments,
  apiKeyIdentifierLength,
  apiKeyLastFour,
  apiKeyPrefix,
  apiKeySecretLength,
  formatApiKey,
  InvalidApiKeyFormatError,
  type ParsedApiKey,
  parseApiKey,
  tryParseApiKey,
} from './tenant/api-key-format';
export {
  type ApiKeyScope,
  apiKeyScopes,
  defaultApiKeyScopes,
  hasScope,
  isApiKeyScope,
} from './tenant/api-key-scope';
export {
  type ApplicationStatus,
  applicationStatuses,
  canApplicationAcceptNotifications,
} from './tenant/application-status';
export {
  hasAtLeastRole,
  type UserRole,
  userRoles,
  type UserStatus,
  userStatuses,
} from './tenant/user-role';
