import {
  type DeliveryAcknowledgement,
  isDeliveryAcknowledgement,
} from '../notification/delivery-acknowledgement';
import { type ProviderSessionStatus } from './whatsapp-provider.port';

/**
 * What the platform understands a provider callback to mean.
 *
 * The provider's own envelope shape stays in the adapter. Translating to this
 * union at the edge is what keeps the delivery rules free of any knowledge of
 * WAHA's JSON, and it is why an unrecognised event is a value rather than a
 * parse failure: a provider upgrade that adds an event must not take webhook
 * ingestion down.
 */
export type ProviderEvent =
  | {
      readonly kind: 'message_acknowledgement';
      readonly providerMessageId: string;
      readonly acknowledgement: DeliveryAcknowledgement;
      /** False for an inbound message, which the platform did not send and does not track. */
      readonly fromUs: boolean;
    }
  | {
      readonly kind: 'session_status';
      readonly sessionName: string;
      readonly status: ProviderSessionStatus;
      readonly phoneNumber: string | null;
      readonly pushName: string | null;
    }
  | { readonly kind: 'unsupported'; readonly eventType: string };

export function toDeliveryAcknowledgement(value: number): DeliveryAcknowledgement | undefined {
  return isDeliveryAcknowledgement(value) ? value : undefined;
}
