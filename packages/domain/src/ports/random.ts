/**
 * Randomness is injected so retry jitter and send pacing are deterministic
 * under test. Both are correctness-relevant: jitter prevents retry storms and
 * pacing prevents the WhatsApp account being flagged.
 */
export interface RandomPort {
  /** Inclusive on both bounds. */
  integerBetween: (minimum: number, maximum: number) => number;
}

export const RANDOM_PORT = Symbol('RandomPort');
