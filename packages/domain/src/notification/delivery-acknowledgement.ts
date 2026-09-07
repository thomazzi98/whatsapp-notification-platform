/**
 * WhatsApp delivery acknowledgements, as reported by the provider.
 *
 * Two properties drive every decision here: acknowledgements arrive out of
 * order and can repeat, so the highest value seen wins; and READ is optional,
 * because a recipient can switch read receipts off. Treating a missing READ as
 * a delivery problem would misreport a large share of healthy traffic.
 */
export const deliveryAcknowledgements = {
  error: -1,
  pending: 0,
  server: 1,
  device: 2,
  read: 3,
  played: 4,
} as const;

export type DeliveryAcknowledgement =
  (typeof deliveryAcknowledgements)[keyof typeof deliveryAcknowledgements];

const acknowledgementNames: Record<DeliveryAcknowledgement, string> = {
  [deliveryAcknowledgements.error]: 'ERROR',
  [deliveryAcknowledgements.pending]: 'PENDING',
  [deliveryAcknowledgements.server]: 'SERVER',
  [deliveryAcknowledgements.device]: 'DEVICE',
  [deliveryAcknowledgements.read]: 'READ',
  [deliveryAcknowledgements.played]: 'PLAYED',
};

export function isDeliveryAcknowledgement(value: number): value is DeliveryAcknowledgement {
  return Object.values<number>(deliveryAcknowledgements).includes(value);
}

export function describeAcknowledgement(acknowledgement: DeliveryAcknowledgement): string {
  return acknowledgementNames[acknowledgement];
}

/**
 * Acknowledgements are monotonic in meaning but not in arrival, so state is
 * advanced by the maximum ever observed rather than by the latest received.
 */
export function mergeAcknowledgements(
  current: DeliveryAcknowledgement,
  incoming: DeliveryAcknowledgement,
): DeliveryAcknowledgement {
  if (incoming === deliveryAcknowledgements.error) {
    return deliveryAcknowledgements.error;
  }
  if (current === deliveryAcknowledgements.error) {
    return deliveryAcknowledgements.error;
  }
  return Math.max(current, incoming) as DeliveryAcknowledgement;
}

export function isDeliveredAcknowledgement(acknowledgement: DeliveryAcknowledgement): boolean {
  return acknowledgement >= deliveryAcknowledgements.device;
}

export function isReadAcknowledgement(acknowledgement: DeliveryAcknowledgement): boolean {
  return (
    acknowledgement === deliveryAcknowledgements.read ||
    acknowledgement === deliveryAcknowledgements.played
  );
}

export function isFailureAcknowledgement(acknowledgement: DeliveryAcknowledgement): boolean {
  return acknowledgement === deliveryAcknowledgements.error;
}
