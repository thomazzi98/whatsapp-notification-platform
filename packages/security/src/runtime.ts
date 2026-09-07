import { randomBytes, randomInt } from 'node:crypto';

import { type ClockPort, type IdentifierGeneratorPort, type RandomPort } from '@platform/domain';

export function createSystemClock(): ClockPort {
  return { now: () => new Date() };
}

export function createSystemRandom(): RandomPort {
  return {
    integerBetween: (minimum: number, maximum: number): number => {
      if (maximum <= minimum) {
        return minimum;
      }
      // randomInt's upper bound is exclusive; the port's contract is inclusive.
      return randomInt(minimum, maximum + 1);
    },
  };
}

/**
 * UUID version 7: a millisecond timestamp followed by randomness.
 *
 * Node has no built-in generator, and the property matters enough to implement:
 * time-ordered keys keep inserts appending at the right edge of the primary key
 * index, where random version 4 identifiers scatter writes across the whole
 * index and bloat it. The notifications and events tables are the hot ones.
 */
export function generateUuidVersion7(timestampMilliseconds: number): string {
  const bytes = randomBytes(16);

  bytes.writeUIntBE(timestampMilliseconds, 0, 6);

  // Version 7 in the high nibble of byte 6.
  const versionByte = bytes[6] ?? 0;
  bytes[6] = (versionByte & 0x0f) | 0x70;
  // RFC 4122 variant in the two high bits of byte 8.
  const variantByte = bytes[8] ?? 0;
  bytes[8] = (variantByte & 0x3f) | 0x80;

  const hex = bytes.toString('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function createIdentifierGenerator(clock: ClockPort): IdentifierGeneratorPort {
  return { generate: () => generateUuidVersion7(clock.now().getTime()) };
}
