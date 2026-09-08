import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { placeholderSecret } from '../src/environment-schema';

/**
 * Turns the committed example into a usable local `.env` by generating real
 * secrets. Without it a first run fails configuration validation, and the
 * developer has to hand-craft base64 keys before seeing anything work.
 */
const repositoryRoot = path.resolve(process.cwd(), '../..');
const examplePath = path.resolve(repositoryRoot, '.env.example');
const targetPath = path.resolve(repositoryRoot, '.env');
const shouldOverwrite = process.argv.includes('--force');

if (!shouldOverwrite && existsSync(targetPath)) {
  process.stdout.write('.env already exists. Pass --force to regenerate it.\n');
  process.exit(0);
}

const generatedSecrets = new Map<string, string>([
  ['SECURITY_API_KEY_PEPPER', randomBytes(32).toString('base64')],
  ['SECURITY_ENCRYPTION_KEY', randomBytes(32).toString('base64')],
  ['SECURITY_CURSOR_SIGNING_KEY', randomBytes(32).toString('base64')],
  ['LOG_RECIPIENT_SALT', randomBytes(32).toString('base64')],
  ['WAHA_API_KEY', randomBytes(24).toString('hex')],
]);

const rendered = readFileSync(examplePath, 'utf8')
  .split('\n')
  .map((line) => {
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1 || line.startsWith('#')) {
      return line;
    }

    const variableName = line.slice(0, separatorIndex);
    const currentValue = line.slice(separatorIndex + 1);
    const generated = generatedSecrets.get(variableName);
    const requiresGeneration = currentValue === placeholderSecret || currentValue === '';

    if (requiresGeneration && generated !== undefined) {
      return `${variableName}=${generated}`;
    }
    return line;
  })
  .join('\n');

/**
 * Compose reads this file too, and `COMPOSE_PROFILES` is how it decides which
 * WhatsApp provider to start. It is not application configuration, so it lives
 * here rather than in the schema that generates `.env.example`: the schema
 * describes what the platform needs to run, and nothing in the platform reads
 * this.
 */
const composeSection = [
  '',
  '# Read by Docker Compose, not by the platform.',
  '# whatsapp: the real provider, which needs a phone to pair.',
  '# stub: a deterministic stand-in, for development without one.',
  'COMPOSE_PROFILES=whatsapp',
  '',
].join('\n');

writeFileSync(targetPath, `${rendered.trimEnd()}\n${composeSection}`, 'utf8');
process.stdout.write(`Wrote ${targetPath} with freshly generated secrets.\n`);
