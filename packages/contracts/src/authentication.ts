import { z } from 'zod';

/**
 * Twelve characters with no composition rules. Length is the property that
 * actually resists guessing; character-class rules mostly push people toward
 * predictable substitutions.
 */
export const passwordSchema = z
  .string()
  .min(12, 'The password must be at least 12 characters.')
  .max(256);

export const registerRequestSchema = z.object({
  organizationName: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  password: passwordSchema,
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authenticatedUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
  organization: z.object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
  }),
});

export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;
