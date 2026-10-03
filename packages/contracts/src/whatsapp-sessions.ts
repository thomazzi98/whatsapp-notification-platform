import { providerSessionStatuses, sendingPauseReasons } from '@platform/domain';
import { z } from 'zod';

export const whatsAppSessionCreationRequestSchema = z.object({
  displayName: z.string().min(1).max(80),
});

export type WhatsAppSessionCreationRequest = z.infer<typeof whatsAppSessionCreationRequestSchema>;

/**
 * What WhatsApp last reported about the account. The status of the quota is
 * WhatsApp's own word and an open set, so it is a string rather than an enum.
 */
const accountLimitsResponseSchema = z.object({
  reachoutTimelock: z
    .object({
      isActive: z.boolean(),
      endsAt: z.iso.datetime().nullable(),
      enforcementType: z.string().nullable(),
    })
    .nullable(),
  newChatQuota: z
    .object({
      status: z.string(),
      /** Negative when the account has no cap. */
      total: z.number(),
      used: z.number(),
      cycleEndsAt: z.iso.datetime().nullable(),
    })
    .nullable(),
  checkedAt: z.iso.datetime().nullable(),
});

export const whatsAppSessionResponseSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  status: z.enum(providerSessionStatuses),
  /**
   * The paired account, once there is one. Never the signing key or the
   * provider session name: both are infrastructure detail, and one of them is a
   * secret.
   */
  phoneNumber: z.string().nullable(),
  pushName: z.string().nullable(),
  lastError: z.string().nullable(),
  /**
   * Nothing is sent from the connection before this, because WhatsApp is
   * restricting the number. A time already past is a pause about to be lifted.
   */
  sendingPausedUntil: z.iso.datetime().nullable(),
  sendingPausedReason: z.enum(sendingPauseReasons).nullable(),
  /** Null until anything has been heard about the account's limits. */
  accountLimits: accountLimitsResponseSchema.nullable(),
  lastStatusAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export type WhatsAppSessionResponse = z.infer<typeof whatsAppSessionResponseSchema>;

export const whatsAppSessionListResponseSchema = z.object({
  data: z.array(whatsAppSessionResponseSchema),
});

export const qrCodeResponseSchema = z.object({
  mimeType: z.string(),
  /** Base64 encoded image bytes, ready to place in a data URL. */
  data: z.string(),
});

export type QrCodeResponse = z.infer<typeof qrCodeResponseSchema>;
