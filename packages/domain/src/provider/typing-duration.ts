import { type RandomPort } from '../ports/random';

/** Roughly how long a person takes per character, typing on a phone. */
const MILLISECONDS_PER_CHARACTER = 40;

export const minimumTypingMilliseconds = 2000;
export const maximumTypingMilliseconds = 8000;

/**
 * How long to show "typing…" before a message goes out.
 *
 * Proportional to the length of the text, the way a person types, with a
 * random spread on top so that two messages of the same length do not take the
 * same time: identical intervals are what automated-messaging detection looks
 * for, the same reason sends are paced at random rather than on a metronome.
 * Bounded at both ends so a one-word message still shows the indicator and a
 * long one does not hold a worker for half a minute.
 */
export function computeTypingMilliseconds(characterCount: number, random: RandomPort): number {
  const proportional = Math.max(0, characterCount) * MILLISECONDS_PER_CHARACTER;
  const spread = Math.floor(proportional / 4);
  const jittered = proportional - spread + random.integerBetween(0, spread * 2);

  return Math.min(Math.max(jittered, minimumTypingMilliseconds), maximumTypingMilliseconds);
}
