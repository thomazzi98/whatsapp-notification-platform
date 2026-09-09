#!/usr/bin/env node
/**
 * Refuses to let a credential reach the repository, or stay in its history.
 *
 * A generic scanner flags every long string and gets switched off within a
 * week. This one knows the four shapes this platform actually produces — its
 * own API keys, the base64 secrets its configuration requires, database URLs
 * and private keys — and separates a real one from a fixture by entropy rather
 * than by a list of exceptions that would need maintaining.
 *
 * Run with --self-test to check the detection still works: it classifies known
 * secrets and known fixtures and fails if it gets either wrong. A scanner that
 * has quietly stopped matching is worse than no scanner, because it reports
 * success.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const SELF = 'tools/scripts/verify-secrets.mjs';

/**
 * Shannon entropy per character. A generated secret sits near 6 bits; a
 * placeholder written by a person, or a fixture spelled out to be obviously
 * fake, sits well below 4.
 */
function entropyPerCharacter(value) {
  const counts = new Map();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }

  return entropy;
}

const ENTROPY_THRESHOLD = 4.2;

const rules = [
  {
    name: 'platform API key',
    // The full token: prefix, twelve character identifier, thirty-two
    // character secret.
    pattern: /wnp_(?:live|test)_[A-Za-z0-9]{44}/g,
    isReal: (match) => entropyPerCharacter(match.slice(9)) >= ENTROPY_THRESHOLD,
  },
  {
    name: 'configuration secret',
    pattern:
      /(?:PEPPER|ENCRYPTION_KEY|SIGNING_KEY|RECIPIENT_SALT|SECRET)\s*[:=]\s*['"]?([A-Za-z0-9+/]{32,}={0,2})/g,
    isReal: (match, groups) => entropyPerCharacter(groups[0]) >= ENTROPY_THRESHOLD,
  },
  {
    name: 'database URL with a password',
    pattern: /postgres(?:ql)?:\/\/[^:\s'"]+:([^@\s'"]{8,})@/g,
    // Entropy is the wrong test here: a sixteen character password cannot
    // exceed four bits per character however random it is. Two things are not
    // credentials — an environment reference, which is a name rather than a
    // value, and the local development password, which is named, documented
    // and deliberately in the manifest. Anything else is a finding.
    isReal: (match, groups) =>
      !groups[0].includes('${') &&
      !/^(?:platform_[a-z_]+|postgres|password)$/.test(groups[0]) &&
      // A fixture has to say so in the value itself. Exempting whole files
      // instead would mean a real credential in a test is a credential the
      // scanner has agreed not to look at.
      !/not[-_]?a[-_]?real|example|fixture|placeholder|dummy/i.test(groups[0]),
  },
  {
    name: 'private key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    isReal: () => true,
  },
];

function findSecrets(contents) {
  const found = [];

  for (const rule of rules) {
    for (const match of contents.matchAll(rule.pattern)) {
      if (rule.isReal(match[0], match.slice(1))) {
        found.push({ rule: rule.name, sample: `${match[0].slice(0, 12)}…` });
      }
    }
  }

  return found;
}

function selfTest() {
  const mustMatch = [
    ['platform API key', 'wnp_live_aB3xK9mQ7wZ2rT5vY8nH4jL6pD1sG0fCuE7iO9kM2aXb'],
    [
      'configuration secret',
      'SECURITY_API_KEY_PEPPER=k9Xw2Qm7ZrT5vY8nH4jL6pD1sG0fCuE7iO9kM2aXbNc=',
    ],
    ['database URL with a password', 'postgres://app:x9Kq2Wm7ZrT5vY8n@db:5432/notifications'],
    ['private key', '-----BEGIN PRIVATE KEY-----'],
  ];
  const mustNotMatch = [
    'wnp_test_notarealkey0000000000000000000000000000',
    'SECURITY_API_KEY_PEPPER=replace-me-with-a-32-byte-base64-value',
    'postgres://platform_system:platform_system_password@postgres:5432/notifications',
    'postgres://app:not-a-real-password@postgres:5432/notifications',
    'postgres://${DATABASE_SYSTEM_USER:-platform_system}:${DATABASE_SYSTEM_PASSWORD:-x}@postgres:5432/n',
    'wnp_live_thisIsProbablySomeonesRealKeyValue',
  ];

  const problems = [];
  for (const [expected, sample] of mustMatch) {
    const found = findSecrets(sample);
    if (!found.some((entry) => entry.rule === expected)) {
      problems.push(`the scanner no longer detects a ${expected}`);
    }
  }
  for (const sample of mustNotMatch) {
    if (findSecrets(sample).length > 0) {
      problems.push(`the scanner now reports a fixture as a secret: ${sample.slice(0, 40)}`);
    }
  }

  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('The secret scanner still recognises secrets and still ignores fixtures.\n');
}

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: repositoryRoot, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0 && !line.endsWith('.jsonl'));
}

function scanWorkingTree() {
  const findings = [];

  for (const file of trackedFiles()) {
    if (file === SELF) {
      continue;
    }

    let contents;
    try {
      contents = readFileSync(path.join(repositoryRoot, file), 'utf8');
    } catch {
      continue;
    }

    for (const secret of findSecrets(contents)) {
      findings.push(`${file}: ${secret.rule} (${secret.sample})`);
    }
  }

  return findings;
}

/**
 * A secret removed in a later commit is still published. The whole history is
 * small enough to read in one pass, and this is the only check that would
 * catch a credential that was committed and then deleted.
 */
function scanHistory() {
  const patch = execFileSync(
    'git',
    ['log', '--all', '--no-color', '--unified=0', '--diff-filter=AM', '-p', '--', '.', ':!*.jsonl'],
    { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );

  const findings = [];
  let commit = 'unknown';
  let file = '';

  for (const line of patch.split('\n')) {
    if (line.startsWith('commit ')) {
      commit = line.slice(7, 14);
      continue;
    }
    if (line.startsWith('+++ b/')) {
      file = line.slice(6);
      continue;
    }
    // This file's own samples are secrets by construction, in the working tree
    // and in every commit that has ever touched it.
    if (file === SELF || !line.startsWith('+')) {
      continue;
    }
    for (const secret of findSecrets(line)) {
      findings.push(`${commit}: ${file}: ${secret.rule} (${secret.sample})`);
    }
  }

  return findings;
}

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

const findings = [...scanWorkingTree(), ...scanHistory()];

if (findings.length > 0) {
  process.stderr.write(`${[...new Set(findings)].join('\n')}\n`);
  process.stderr.write(`\n${String(findings.length)} possible credential(s) found.\n`);
  process.exit(1);
}

process.stdout.write('No credentials in the working tree or in the history.\n');
