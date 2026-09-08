#!/usr/bin/env node
/**
 * Checks that every workspace package actually ships what its manifest claims.
 *
 * This exists because the failure it catches is invisible until runtime. A
 * package whose build config emits `dist/src/index.js` while its manifest
 * points at `dist/index.js` compiles cleanly, passes every test that imports it
 * through the TypeScript path, and then fails inside a production container
 * with a bare module resolution error. The same is true of a `files` list that
 * forgets `dist`: `pnpm deploy --prod` copies nothing and the image starts with
 * an empty package.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceDirectories = ['apps', 'packages', 'tools'];

function readManifest(packageDirectory) {
  const manifestPath = path.join(packageDirectory, 'package.json');

  if (!existsSync(manifestPath)) {
    return undefined;
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function collectPackages() {
  const packages = [];

  for (const workspaceDirectory of workspaceDirectories) {
    const absolute = path.join(repositoryRoot, workspaceDirectory);
    if (!existsSync(absolute)) {
      continue;
    }

    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageDirectory = path.join(absolute, entry.name);
      const manifest = readManifest(packageDirectory);

      if (manifest !== undefined) {
        packages.push({ manifest, directory: packageDirectory });
      }
    }
  }

  return packages;
}

function checkPackage({ manifest, directory }) {
  const problems = [];
  const relative = path.relative(repositoryRoot, directory).replaceAll('\\', '/');

  for (const field of ['main', 'types']) {
    const declared = manifest[field];
    if (declared === undefined) {
      continue;
    }
    if (!existsSync(path.join(directory, declared))) {
      problems.push(`${relative}: "${field}" points at ${declared}, which the build did not emit`);
    }
  }

  const publishedFiles = manifest.files ?? [];
  if (manifest.main !== undefined && !publishedFiles.includes('dist')) {
    problems.push(`${relative}: has a "main" but does not list "dist" in "files"`);
  }

  return problems;
}

const problems = collectPackages().flatMap((entry) => checkPackage(entry));

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exit(1);
}

process.stdout.write('Every workspace package ships what its manifest declares.\n');
