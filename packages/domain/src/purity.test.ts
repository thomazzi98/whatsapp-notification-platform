import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The manifest is the strongest of the three things that keep the domain pure:
 * a library it does not declare is not resolvable from inside it, whatever
 * anyone writes in an import. The layering cruise catches an import that slips
 * past; this catches the change that would make such an import work.
 *
 * It is one file read rather than a graph walk, so it also runs in the unit
 * suite, where a mistake is found in seconds instead of in continuous
 * integration.
 */
describe('the domain package manifest', () => {
  const manifest = JSON.parse(
    // Vitest runs with the package root as its working directory, and this
    // package compiles to CommonJS, where import.meta does not exist.
    readFileSync(path.resolve('package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  it('declares no runtime dependency at all', () => {
    // Not "no infrastructure dependency": nothing. The rules, the state
    // machine and the retry arithmetic need no library, and the moment one is
    // declared, Drizzle or a WhatsApp client becomes one import away.
    expect(manifest.dependencies ?? {}).toStrictEqual({});
  });

  it('keeps its development dependencies to the toolchain', () => {
    const allowed = new Set(['eslint', 'rimraf', 'typescript', 'vitest']);
    const declared = Object.keys(manifest.devDependencies ?? {});

    expect(declared.filter((name) => !allowed.has(name))).toStrictEqual([]);
  });
});
