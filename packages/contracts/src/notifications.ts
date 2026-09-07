import { notificationStatuses } from '@platform/domain';
import { z } from 'zod';

export const notificationCreationRequestSchema = z.object({
  /**
   * International format is required rather than inferred. Guessing a country
   * from a national number delivers the message to a stranger when the guess is
   * wrong.
   */
  recipient: z
    .string()
    .regex(
      /^\+[1-9]\d{7,14}$/,
      'The recipient must be in international format, such as +5511999998888.',
    ),
  body: z.string().min(1).max(4096),
  whatsAppSessionId: z.uuid().optional(),
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
  maximumAttempts: z.int().min(1).max(10).optional(),
  metadata: z.record(z.string().max(64), z.string().max(512)).default({}),
});

export type NotificationCreationRequest = z.infer<typeof notificationCreationRequestSchema>;

export const notificationResponseSchema = z.object({
  id: z.uuid(),
  status: z.enum(notificationStatuses),
  recipient: z.string(),
  body: z.string(),
  whatsAppSessionId: z.uuid(),
  scheduledAt: z.iso.datetime().nullable(),
  attemptCount: z.int(),
  maximumAttempts: z.int(),
  nextAttemptAt: z.iso.datetime().nullable(),
  providerMessageId: z.string().nullable(),
  sentAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  readAt: z.iso.datetime().nullable(),
  failedAt: z.iso.datetime().nullable(),
  failureCode: z.string().nullable(),
  failureReason: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type NotificationResponse = z.infer<typeof notificationResponseSchema>;

export const notificationEventResponseSchema = z.object({
  id: z.uuid(),
  eventType: z.string(),
  fromStatus: z.enum(notificationStatuses).nullable(),
  toStatus: z.enum(notificationStatuses).nullable(),
  attemptNumber: z.int().nullable(),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: z.iso.datetime(),
});

export type NotificationEventResponse = z.infer<typeof notificationEventResponseSchema>;

const notificationStatusSchema = z.enum(notificationStatuses);

/** A single status, or several repeated in the query string. */
const statusFilterSchema = z.union([notificationStatusSchema, z.array(notificationStatusSchema)]);

export const notificationListQuerySchema = z.object({
  status: statusFilterSchema.optional(),
  recipient: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type NotificationListQueryParameters = z.infer<typeof notificationListQuerySchema>;

export const notificationListResponseSchema = z.object({
  data: z.array(notificationResponseSchema),
  nextCursor: z.string().nullable(),
});
