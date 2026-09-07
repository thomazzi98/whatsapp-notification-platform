import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { environmentSchema, placeholderSecret } from './environment-schema';
import { generateEnvironmentExample } from './generate-environment-example';
import { parseConfiguration } from './parse-configuration';

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

describe('the generated example is usable', () => {
  /**
   * The strongest guard on this generator. An earlier version silently emitted
   * empty values for variables whose default sat behind a transform, and the
   * only symptom was a confusing validation failure at container startup.
   */
  it('parses successfully once the placeholder secrets are replaced', () => {
    const environment: Record<string, string> = {};

    for (const line of generateEnvironmentExample().split('\n')) {
      const separatorIndex = line.indexOf('=');
      if (separatorIndex === -1 || line.startsWith('#')) {
        continue;
      }
      const variableName = line.slice(0, separatorIndex);
      const value = line.slice(separatorIndex + 1);
      environment[variableName] =
        value === placeholderSecret ? randomBytes(32).toString('base64') : value;
    }

    // The provider key is not a base64 secret, just a long opaque string.
    environment.WAHA_API_KEY = 'a-waha-api-key-value';

    expect(() => parseConfiguration(environment)).not.toThrow();
  });

  it('leaves no variable with an empty value', () => {
    const emptyVariables = generateEnvironmentExample()
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#') && line.endsWith('='))
      .map((line) => line.slice(0, -1));

    expect(emptyVariables).toEqual([]);
  });
});
