import { hash, verify } from '@node-rs/argon2';

/**
 * OWASP's baseline Argon2id parameters. They are encoded inside the resulting
 * hash string, so raising them later does not invalidate existing credentials —
 * an old hash still verifies with the parameters it was created with.
 */
const argon2Options = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plainTextPassword: string): Promise<string> {
  return hash(plainTextPassword, argon2Options);
}

/**
 * Returns false rather than throwing on a malformed stored hash, so a corrupt
 * row denies access instead of turning every login attempt into a 500.
 */
export async function isPasswordValid(
  storedHash: string,
  plainTextPassword: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plainTextPassword);
  } catch {
    return false;
  }
}
