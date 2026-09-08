export { classifyHttpStatus, classifyTransportError } from './classify-failure';
export { WahaProvider, type WahaProviderOptions } from './waha-provider';
export {
  isWebhookSignatureValid,
  isWebhookTimestampAcceptable,
  parseWebhookEnvelope,
  toProviderEvent,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type WebhookEnvelope,
} from './webhook';
