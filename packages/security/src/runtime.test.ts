import { describe, expect, it } from 'vitest';

import {
  createIdentifierGenerator,
  createSystemClock,
  createSystemRandom,
  generateUuidVersion7,
} from './runtime';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('generateUuidVersion7', () => {
  it('produces a well formed UUID', () => {
    expect(generateUuidVersion7(Date.parse('2026-09-07T12:00:00.000Z'))).toMatch(UUID_PATTERN);
  });

  it('sets the version and variant bits', () => {
    const identifier = generateUuidVersion7(Date.parse('2026-09-07T12:00:00.000Z'));

    expect(identifier.charAt(14)).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(identifier.charAt(19));
  });

  it('sorts lexicographically in timestamp order, which is the whole point', () => {
    // Time-ordered keys keep primary key inserts appending at the right edge of
    // the index rather than scattering across it.
    const identifiers = [
      generateUuidVersion7(Date.parse('2026-09-07T12:00:00.000Z')),
      generateUuidVersion7(Date.parse('2026-09-07T12:00:01.000Z')),
      generateUuidVersion7(Date.parse('2026-09-07T13:00:00.000Z')),
      generateUuidVersion7(Date.parse('2026-09-08T12:00:00.000Z')),
    ];

    expect(identifiers.toSorted((left, right) => left.localeCompare(right))).toEqual(identifiers);
  });

  it('is unique within the same millisecond', () => {
    const timestamp = Date.parse('2026-09-07T12:00:00.000Z');
    const identifiers = new Set(Array.from({ length: 500 }, () => generateUuidVersion7(timestamp)));

    expect(identifiers.size).toBe(500);
  });

  it('encodes the supplied timestamp in the leading bytes', () => {
    const timestamp = Date.parse('2026-09-07T12:00:00.000Z');
    const identifier = generateUuidVersion7(timestamp);
    const encoded = Number.parseInt(identifier.slice(0, 8) + identifier.slice(9, 13), 16);

    expect(encoded).toBe(timestamp);
  });
});

describe('createIdentifierGenerator', () => {
  it('derives identifiers from the injected clock', () => {
    const fixedTime = new Date('2026-09-07T12:00:00.000Z');
    const generator = createIdentifierGenerator({ now: () => fixedTime });

    const first = generator.generate();
    const second = generator.generate();

    expect(first).not.toBe(second);
    expect(first.slice(0, 8)).toBe(second.slice(0, 8));
  });
});

describe('createSystemRandom', () => {
  it('includes both bounds, as the port contract requires', () => {
    const random = createSystemRandom();
    const observed = new Set(Array.from({ length: 400 }, () => random.integerBetween(0, 3)));

    expect(observed).toEqual(new Set([0, 1, 2, 3]));
  });

  it('returns the bound when the range is empty', () => {
    const random = createSystemRandom();

    expect(random.integerBetween(7, 7)).toBe(7);
    expect(random.integerBetween(9, 2)).toBe(9);
  });

  it('stays inside the requested range', () => {
    const random = createSystemRandom();

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = random.integerBetween(30, 60);
      expect(value).toBeGreaterThanOrEqual(30);
      expect(value).toBeLessThanOrEqual(60);
    }
  });
});

describe('createSystemClock', () => {
  it('reports the current time', () => {
    const before = Date.now();
    const now = createSystemClock().now().getTime();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
