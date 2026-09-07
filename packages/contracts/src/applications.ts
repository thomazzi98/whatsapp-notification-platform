import { z } from 'zod';

export const applicationSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9-]*$/,
    'Use lower case letters, digits and hyphens, starting with a letter.',
  );

export const applicationCreationRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: applicationSlugSchema,
});

export type ApplicationCreationRequest = z.infer<typeof applicationCreationRequestSchema>;

export const updateApplicationRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    rateLimitPerMinute: z.int().min(1).max(6000).optional(),
    rateLimitBurst: z.int().min(1).max(1000).optional(),
    dailySendLimit: z.int().positive().nullable().optional(),
    defaultMaximumAttempts: z.int().min(1).max(10).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

export type UpdateApplicationRequest = z.infer<typeof updateApplicationRequestSchema>;

export const applicationResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(['ACTIVE', 'SUSPENDED']),
  rateLimitPerMinute: z.int(),
  rateLimitBurst: z.int(),
  dailySendLimit: z.int().nullable(),
  defaultMaximumAttempts: z.int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type ApplicationResponse = z.infer<typeof applicationResponseSchema>;
