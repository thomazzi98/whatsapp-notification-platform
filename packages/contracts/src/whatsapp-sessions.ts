import { providerSessionStatuses } from '@platform/domain';
import { z } from 'zod';

export const whatsAppSessionCreationRequestSchema = z.object({
  displayName: z.string().min(1).max(80),
});

export type WhatsAppSessionCreationRequest = z.infer<typeof whatsAppSessionCreationRequestSchema>;

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
