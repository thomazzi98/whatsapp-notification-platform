import { describe, expect, it } from 'vitest';

import { apiKeyCreationRequestSchema } from './api-keys';
import { applicationCreationRequestSchema, applicationSlugSchema } from './applications';
import { passwordSchema, registerRequestSchema } from './authentication';

describe('password rules', () => {
  it('requires a length that actually resists guessing', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('exactly12chr').success).toBe(true);
  });

  it('imposes no composition rules, which push people toward predictable substitutions', () => {
    expect(passwordSchema.safeParse('all lower case letters only').success).toBe(true);
  });
});

describe('registration', () => {
  const valid = {
    organizationName: 'Acme',
    name: 'Rafael',
    email: 'rafael@example.com',
    password: 'a-long-enough-password',
  };

  it('accepts a well formed request', () => {
    expect(registerRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an invalid email address', () => {
    expect(registerRequestSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(
      false,
    );
  });

  it('trims surrounding whitespace from names', () => {
    const parsed = registerRequestSchema.parse({ ...valid, name: '  Rafael  ' });

    expect(parsed.name).toBe('Rafael');
  });

  it('rejects a name that is only whitespace', () => {
    expect(registerRequestSchema.safeParse({ ...valid, name: ' '.repeat(3) }).success).toBe(false);
  });
});

describe('application slug', () => {
  it('accepts url safe identifiers', () => {
    for (const slug of ['store', 'my-store', 'store2', 'a']) {
      expect(applicationSlugSchema.safeParse(slug).success, slug).toBe(true);
    }
  });

  it('rejects anything that would not survive a url', () => {
    for (const slug of ['My-Store', '2store', '-store', 'store_name', 'store name', '']) {
      expect(applicationSlugSchema.safeParse(slug).success, slug).toBe(false);
    }
  });

  it('is required when creating an application', () => {
    expect(applicationCreationRequestSchema.safeParse({ name: 'Store' }).success).toBe(false);
  });
});

describe('api key creation', () => {
  it('defaults to a read and write scope set when none is given', () => {
    const parsed = apiKeyCreationRequestSchema.parse({ name: 'backend' });

    expect(parsed.scopes).toContain('notifications:write');
    expect(parsed.scopes).toContain('notifications:read');
  });

  it('rejects an empty scope list', () => {
    // A key with no scopes would authenticate successfully and then be able to
    // do nothing, which is a confusing failure to debug.
    const result = apiKeyCreationRequestSchema.safeParse({ name: 'useless', scopes: [] });

    expect(result.success).toBe(false);
  });

  it('rejects an unknown scope rather than silently dropping it', () => {
    const result = apiKeyCreationRequestSchema.safeParse({
      name: 'backend',
      scopes: ['notifications:write', 'everything:admin'],
    });

    expect(result.success).toBe(false);
  });

  it('accepts a null expiry, meaning the key does not expire', () => {
    expect(
      apiKeyCreationRequestSchema.safeParse({ name: 'backend', expiresAt: null }).success,
    ).toBe(true);
  });

  it('rejects an expiry that is not a timestamp', () => {
    expect(
      apiKeyCreationRequestSchema.safeParse({ name: 'backend', expiresAt: 'tomorrow' }).success,
    ).toBe(false);
  });
});
