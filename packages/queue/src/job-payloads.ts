import { z } from 'zod';

/**
 * Every job carries the correlation identifier of the request that created it,
 * so a log line in the worker can be joined to the API call that caused it.
 * It is a field of the payload rather than a side channel precisely so it
 * survives a broker restart.
 */
export const baseJobPayloadSchema = z.object({
  correlationId: z.string().min(1),
});

export const notificationDispatchPayloadSchema = baseJobPayloadSchema.extend({
  notificationId: z.uuid(),
  applicationId: z.uuid(),
});

export const webhookProcessPayloadSchema = baseJobPayloadSchema.extend({
  webhookDeliveryId: z.uuid(),
});
