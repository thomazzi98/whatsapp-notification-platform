import { describe, expect, it } from 'vitest';

import { type RandomPort } from '../ports/random';
import {
  computeTypingMilliseconds,
  maximumTypingMilliseconds,
  minimumTypingMilliseconds,
} from './typing-duration';

const lowest: RandomPort = { integerBetween: (minimum) => minimum };
const highest: RandomPort = { integerBetween: (_minimum, maximum) => maximum };

describe('how long "typing…" is shown', () => {
  it('grows with the length of the message', () => {
    const short = computeTypingMilliseconds(80, lowest);
    const long = computeTypingMilliseconds(160, lowest);

    expect(long).toBeGreaterThan(short);
  });

  it('varies between two messages of the same length', () => {
    expect(computeTypingMilliseconds(120, lowest)).toBeLessThan(
      computeTypingMilliseconds(120, highest),
    );
  });

  it('still shows the indicator for a one-word message', () => {
    expect(computeTypingMilliseconds(2, highest)).toBe(minimumTypingMilliseconds);
  });

  it('never holds a worker longer than the ceiling, however long the message', () => {
    expect(computeTypingMilliseconds(4096, highest)).toBe(maximumTypingMilliseconds);
  });
});
