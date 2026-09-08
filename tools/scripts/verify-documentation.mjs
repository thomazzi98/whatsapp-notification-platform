#!/usr/bin/env node
/**
 * Checks the documentation the way a reader would find it broken.
 *
 * Prose rots differently from code: nothing fails to compile when a link dies,
 * an architecture diagram stops parsing, or a decision record is written and
 * never added to its index. These are the four failures that have actually
 * happened in this repository, so these are the four that are checked.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { JSDOM } from 'jsdom';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const failures = [];

function record(file, problem) {
  failures.push(`${path.relative(repositoryRoot, file).replaceAll('\\', '/')}: ${problem}`);
}

function documentationFiles() {
  const tracked = execFileSync('git', ['ls-files', '*.md'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  return tracked
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => path.join(repositoryRoot, line));
}

/** A link to a file that does not exist is the most common rot, and the least visible. */
function checkLinks(file, contents) {
  const directory = path.dirname(file);

  for (const match of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) {
      continue;
    }

    const withoutAnchor = target.split('#')[0];
    if (withoutAnchor.length === 0) {
      continue;
    }
    if (!existsSync(path.resolve(directory, withoutAnchor))) {
      record(file, `link to "${target}" does not resolve`);
    }
  }
}

/**
 * A diagram that does not parse renders as a wall of source on the page that
 * is meant to explain the system fastest.
 */
async function checkDiagrams(file, contents, mermaid) {
  const blocks = [...contents.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((match) => match[1]);

  for (const [index, block] of blocks.entries()) {
    try {
      await mermaid.parse(block);
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      record(file, `mermaid block ${index + 1} does not parse: ${reason}`);
    }
  }
}

/** Placeholders are how an unfinished section survives review. */
function checkPlaceholders(file, contents) {
  for (const marker of ['TODO', 'TBD', 'FIXME', 'Coming soon', 'lorem ipsum']) {
    if (contents.toLowerCase().includes(marker.toLowerCase())) {
      record(file, `contains the placeholder "${marker}"`);
    }
  }
}

/** A decision record nobody can find from the index may as well not exist. */
function checkDecisionRecordIndex() {
  const indexPath = path.join(repositoryRoot, 'docs', 'adr', 'README.md');
  if (!existsSync(indexPath)) {
    failures.push('docs/adr/README.md: the decision record index is missing');
    return;
  }

  const index = readFileSync(indexPath, 'utf8');
  const recorded = execFileSync('git', ['ls-files', 'docs/adr/*.md'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => path.basename(line))
    .filter((name) => name.length > 0 && name !== 'README.md');

  for (const name of recorded) {
    if (!index.includes(name)) {
      record(indexPath, `does not list ${name}`);
    }
  }
}

async function loadMermaid() {
  // mermaid reaches for browser globals at import time; the parser itself needs
  // nothing more than a document to exist.
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.DOMPurify = {
    sanitize: (value) => value,
    addHook: () => undefined,
    setConfig: () => undefined,
  };

  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({ startOnLoad: false });

  return mermaid;
}

const mermaid = await loadMermaid();

for (const file of documentationFiles()) {
  const contents = readFileSync(file, 'utf8');
  checkLinks(file, contents);
  checkPlaceholders(file, contents);
  await checkDiagrams(file, contents, mermaid);
}

checkDecisionRecordIndex();

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.stderr.write(`\n${String(failures.length)} documentation problem(s).\n`);
  process.exit(1);
}

process.stdout.write('Documentation links, diagrams and the decision record index are intact.\n');
