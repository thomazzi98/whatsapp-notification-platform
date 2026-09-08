import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { logEvents } from './log-events';

/**
 * The event vocabulary is only worth having if it describes what the platform
 * actually emits. Left unchecked it drifts both ways: names accumulate for
 * events nobody writes, and log lines appear with a string literal that no
 * dashboard is looking for.
 *
 * Fifteen of thirty-three names were unemitted when this test was written.
 */
// Vitest runs with the package root as its working directory, and this package
// compiles to CommonJS, where import.meta does not exist.
const repositoryRoot = path.resolve('..', '..');
const skipped = new Set(['node_modules', 'dist', '.git', '.turbo', 'test-results', 'coverage']);

function sourceFiles(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory)) {
    if (skipped.has(entry)) {
      continue;
    }
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('log-events.ts')) {
      found.push(full);
    }
  }

  return found;
}

const corpus = [
  ...sourceFiles(path.join(repositoryRoot, 'packages')),
  ...sourceFiles(path.join(repositoryRoot, 'apps')),
]
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

describe('the log event vocabulary', () => {
  it('declares no event that nothing emits', () => {
    const unemitted = Object.keys(logEvents).filter(
      (name) => !corpus.includes(`logEvents.${name}`),
    );

    expect(unemitted).toStrictEqual([]);
  });

  it('gives every event a dotted name, so a dashboard can group them', () => {
    for (const value of Object.values(logEvents)) {
      expect(value).toMatch(/^[a-z]+(?:_[a-z]+)*(?:\.[a-z]+(?:_[a-z]+)*)+$/);
    }
  });
});
