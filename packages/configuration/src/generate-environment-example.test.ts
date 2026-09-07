import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { environmentSchema } from './environment-schema';
import { generateEnvironmentExample } from './generate-environment-example';

const repositoryRoot = path.resolve(process.cwd(), '../..');

describe('generateEnvironmentExample', () => {
  it('documents every variable the schema validates', () => {
    const generated = generateEnvironmentExample();

    for (const variableName of Object.keys(environmentSchema.shape)) {
      expect(generated).toContain(`${variableName}=`);
    }
  });

  it('marks variables without a default as required', () => {
    const generated = generateEnvironmentExample();
    const lines = generated.split('\n');
    const requiredIndex = lines.indexOf('# Required.');

    expect(requiredIndex).toBeGreaterThan(-1);
    expect(lines[requiredIndex + 1]).toMatch(/^[A-Z][A-Z0-9_]*=/);
  });

  it('never writes a usable secret into the example', () => {
    const generated = generateEnvironmentExample();
    const secretVariables = [
      'SECURITY_API_KEY_PEPPER',
      'SECURITY_ENCRYPTION_KEY',
      'SECURITY_CURSOR_SIGNING_KEY',
      'LOG_RECIPIENT_SALT',
    ];

    for (const variableName of secretVariables) {
      const line = generated
        .split('\n')
        .find((candidate) => candidate.startsWith(`${variableName}=`));

      expect(line).toBeDefined();
      const value = line?.slice(variableName.length + 1) ?? '';
      // A real key is valid base64; the placeholder deliberately is not, so a
      // copied example fails validation instead of shipping a known secret.
      expect(/^[A-Za-z0-9+/]+={0,2}$/.test(value)).toBe(false);
    }
  });

  it('matches the committed .env.example, so documentation cannot drift', () => {
    const committed = readFileSync(path.resolve(repositoryRoot, '.env.example'), 'utf8');

    expect(generateEnvironmentExample()).toBe(committed);
  });
});
