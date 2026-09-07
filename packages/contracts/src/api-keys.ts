import { apiKeyScopes, defaultApiKeyScopes } from '@platform/domain';
import { z } from 'zod';

export const apiKeyCreationRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z
    .array(z.enum(apiKeyScopes))
    .min(1, 'An API key with no scopes could authenticate but do nothing.')
    .default([...defaultApiKeyScopes]),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

export type ApiKeyCreationRequest = z.infer<typeof apiKeyCreationRequestSchema>;

export const apiKeyResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** The public half of the token, safe to display and to log. */
  displayPrefix: z.string(),
  lastFour: z.string(),
  scopes: z.array(z.enum(apiKeyScopes)),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});

export type ApiKeyResponse = z.infer<typeof apiKeyResponseSchema>;

/**
 * The only response in the platform that carries a usable credential. It is
 * returned once, at creation, and the value is never recoverable afterwards.
 */
export const apiKeyCreationResponseSchema = apiKeyResponseSchema.extend({
  plaintextKey: z.string(),
});

export type ApiKeyCreationResponse = z.infer<typeof apiKeyCreationResponseSchema>;
