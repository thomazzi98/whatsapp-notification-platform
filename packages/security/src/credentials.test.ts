import { randomBytes } from 'node:crypto';

import { parseApiKey, tryParseApiKey } from '@platform/domain';
import { describe, expect, it } from 'vitest';

import { isApiKeySecretValid, generateApiKey, hashApiKeySecret } from './api-key';
import { decryptSecret, encryptSecret } from './encryption';
import { hashPassword, isPasswordValid } from './password';
import { generateSessionToken, hashSessionToken, isSessionTokenValid } from './session-token';

const pepper = randomBytes(32).toString('base64');
const encryptionKey = randomBytes(32).toString('base64');

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const storedHash = await hashPassword('correct horse battery staple');

    await expect(isPasswordValid(storedHash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const storedHash = await hashPassword('correct horse battery staple');

    await expect(isPasswordValid(storedHash, 'wrong password')).resolves.toBe(false);
  });

  it('never stores the password itself', async () => {
    const storedHash = await hashPassword('correct horse battery staple');

    expect(storedHash).not.toContain('correct horse');
    expect(storedHash.startsWith('$argon2id$')).toBe(true);
  });

  it('produces a different hash each time, so identical passwords are not detectable', async () => {
    const first = await hashPassword('same password');
    const second = await hashPassword('same password');

    expect(first).not.toBe(second);
    await expect(isPasswordValid(first, 'same password')).resolves.toBe(true);
    await expect(isPasswordValid(second, 'same password')).resolves.toBe(true);
  });

  it('denies access rather than throwing when the stored hash is corrupt', async () => {
    // A damaged row should fail one login, not turn every attempt into a 500.
    await expect(isPasswordValid('not-a-hash', 'anything')).resolves.toBe(false);
    await expect(isPasswordValid('', 'anything')).resolves.toBe(false);
  });

  it('encodes its parameters in the hash, so they can be raised without invalidating keys', async () => {
    const storedHash = await hashPassword('a password');

    expect(storedHash).toContain('m=19456');
    expect(storedHash).toContain('t=2');
    expect(storedHash).toContain('p=1');
  });
});

describe('session tokens', () => {
  it('round trips through hashing', () => {
    const generated = generateSessionToken();

    expect(isSessionTokenValid(generated.tokenHash, generated.token)).toBe(true);
  });

  it('rejects a different token', () => {
    const generated = generateSessionToken();
    const other = generateSessionToken();

    expect(isSessionTokenValid(generated.tokenHash, other.token)).toBe(false);
  });

  it('never lets the stored value reveal the token', () => {
    const generated = generateSessionToken();

    expect(generated.tokenHash.toString('hex')).not.toContain(generated.token);
    expect(generated.tokenHash).toHaveLength(32);
  });

  it('produces a distinct token every time', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateSessionToken().token));

    expect(tokens.size).toBe(50);
  });

  it('is deterministic for the same token, so lookups work', () => {
    const generated = generateSessionToken();

    expect(hashSessionToken(generated.token)).toEqual(generated.tokenHash);
  });

  it('rejects a hash of the wrong length instead of throwing', () => {
    expect(isSessionTokenValid(Buffer.alloc(8), 'anything')).toBe(false);
  });
});

describe('api keys', () => {
  it('generates a token that parses back to its parts', () => {
    const generated = generateApiKey('live', pepper);
    const parsed = parseApiKey(generated.token);

    expect(parsed.environment).toBe('live');
    expect(parsed.identifier).toBe(generated.identifier);
  });

  it('verifies the secret against the stored hash', () => {
    const generated = generateApiKey('live', pepper);
    const parsed = parseApiKey(generated.token);

    expect(isApiKeySecretValid(generated.keyHash, parsed.secret, pepper)).toBe(true);
  });

  it('rejects the right secret under a different pepper', () => {
    // This is the property that makes a database-only compromise useless.
    const generated = generateApiKey('live', pepper);
    const parsed = parseApiKey(generated.token);
    const otherPepper = randomBytes(32).toString('base64');

    expect(isApiKeySecretValid(generated.keyHash, parsed.secret, otherPepper)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const generated = generateApiKey('live', pepper);
    const other = generateApiKey('live', pepper);

    expect(isApiKeySecretValid(generated.keyHash, parseApiKey(other.token).secret, pepper)).toBe(
      false,
    );
  });

  it('never exposes the secret in the stored or displayed fields', () => {
    const generated = generateApiKey('live', pepper);
    const secret = parseApiKey(generated.token).secret;

    expect(generated.displayPrefix).not.toContain(secret);
    expect(generated.keyHash.toString('hex')).not.toContain(secret);
    expect(generated.lastFour).toBe(secret.slice(-4));
  });

  it('generates distinct identifiers, which are a unique index', () => {
    const identifiers = new Set(
      Array.from({ length: 200 }, () => generateApiKey('live', pepper).identifier),
    );

    expect(identifiers.size).toBe(200);
  });

  it('only ever produces tokens the parser accepts', () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const generated = generateApiKey(attempt % 2 === 0 ? 'live' : 'test', pepper);
      expect(tryParseApiKey(generated.token), generated.token).toBeDefined();
    }
  });

  it('is deterministic, so authentication can look up by hash', () => {
    const secret = 'a'.repeat(32);

    expect(hashApiKeySecret(secret, pepper)).toEqual(hashApiKeySecret(secret, pepper));
  });
});

describe('reversible secret encryption', () => {
  it('round trips a value', () => {
    const encrypted = encryptSecret('a webhook signing key', encryptionKey);

    expect(decryptSecret(encrypted, encryptionKey)).toBe('a webhook signing key');
  });

  it('never stores the plain text', () => {
    const encrypted = encryptSecret('a webhook signing key', encryptionKey);

    expect(encrypted.toString('utf8')).not.toContain('webhook signing key');
  });

  it('produces different ciphertext each time for the same input', () => {
    const first = encryptSecret('same value', encryptionKey);
    const second = encryptSecret('same value', encryptionKey);

    expect(first.equals(second)).toBe(false);
  });

  it('refuses to decrypt tampered ciphertext', () => {
    const encrypted = encryptSecret('a webhook signing key', encryptionKey);
    const lastIndex = encrypted.length - 1;
    encrypted.writeUInt8(encrypted.readUInt8(lastIndex) ^ 0xff, lastIndex);

    expect(() => decryptSecret(encrypted, encryptionKey)).toThrow();
  });

  it('refuses to decrypt under a different key', () => {
    const encrypted = encryptSecret('a webhook signing key', encryptionKey);
    const otherKey = randomBytes(32).toString('base64');

    expect(() => decryptSecret(encrypted, otherKey)).toThrow();
  });
});
