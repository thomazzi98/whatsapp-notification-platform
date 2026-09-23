import { notificationStatuses } from '@platform/domain';
import { z } from 'zod';

/**
 * The bound the database also enforces with a CHECK. Declared once so the
 * documented limit and the enforced limit cannot drift apart: before this, an
 * over-long key reached the insert and surfaced as a 500.
 */
export const idempotencyKeySchema = z.string().min(1).max(255);

/**
 * International format is required rather than inferred. Guessing a country
 * from a national number delivers the message to a stranger when the guess is
 * wrong.
 */
const recipientSchema = z
  .string()
  .regex(
    /^\+[1-9]\d{7,14}$/,
    'The recipient must be in international format, such as +5511999998888.',
  );

/** The most recipients one batch may name. */
export const MAXIMUM_BATCH_RECIPIENTS = 50;

export const notificationCreationRequestSchema = z.object({
  recipient: recipientSchema,
  body: z.string().min(1).max(4096),
  whatsAppSessionId: z.uuid().optional(),
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
  maximumAttempts: z.int().min(1).max(10).optional(),
  metadata: z.record(z.string().max(64), z.string().max(512)).default({}),
});

export type NotificationCreationRequest = z.infer<typeof notificationCreationRequestSchema>;

/**
 * One message for several people -- a sale announced to every partner. Each
 * recipient still becomes a notification of its own, with its own delivery and
 * retries: a failure reaching one partner must not hide that the others were
 * reached, nor be retried on their behalf.
 */
export const notificationBatchCreationRequestSchema = notificationCreationRequestSchema
  .omit({ recipient: true })
  .extend({
    recipients: z
      .array(recipientSchema)
      .min(1)
      .max(MAXIMUM_BATCH_RECIPIENTS)
      // Refused rather than collapsed: a list naming someone twice is a caller
      // bug, and quietly sending once would hide it.
      .refine((recipients) => new Set(recipients).size === recipients.length, {
        message: 'Each recipient may appear only once in a batch.',
      }),
  });

export type NotificationBatchCreationRequest = z.infer<
  typeof notificationBatchCreationRequestSchema
>;

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

/** In the order the recipients were given. */
export const notificationBatchResponseSchema = z.object({
  data: z.array(notificationResponseSchema),
});
