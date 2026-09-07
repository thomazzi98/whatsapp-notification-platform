import { describe, expect, it } from 'vitest';

import {
  apiKeyDisplayPrefix,
  apiKeyIdentifierLength,
  apiKeyLastFour,
  apiKeyPrefix,
  apiKeySecretLength,
  formatApiKey,
  InvalidApiKeyFormatError,
  parseApiKey,
  tryParseApiKey,
} from './api-key-format';

const identifier = 'a'.repeat(apiKeyIdentifierLength);
const secret = 'b'.repeat(apiKeySecretLength - 4) + 'c9d2';
const liveToken = formatApiKey('live', identifier, secret);

describe('api key format', () => {
  it('builds a token from an environment, identifier and secret', () => {
    expect(liveToken).toBe(`wnp_live_${identifier}${secret}`);
    expect(liveToken.startsWith(apiKeyPrefix('live'))).toBe(true);
  });

  it('separates live and test environments in the token itself', () => {
    expect(formatApiKey('test', identifier, secret).startsWith('wnp_test_')).toBe(true);
    expect(apiKeyPrefix('live')).not.toBe(apiKeyPrefix('test'));
  });

  it('round trips through parsing', () => {
    expect(parseApiKey(liveToken)).toEqual({ environment: 'live', identifier, secret });
  });

  it('exposes only the public half for display', () => {
    const display = apiKeyDisplayPrefix('live', identifier);

    expect(display).toBe(`wnp_live_${identifier}`);
    expect(display).not.toContain(secret);
  });

  it('shows the last four characters so a key can be recognised', () => {
    expect(apiKeyLastFour(secret)).toBe('c9d2');
    expect(apiKeyLastFour(secret)).toHaveLength(4);
  });
});

describe('tryParseApiKey', () => {
  it('accepts a well formed token', () => {
    expect(tryParseApiKey(liveToken)).toBeDefined();
  });

  it('rejects malformed tokens without throwing', () => {
    const rejected = [
      '',
      'not-a-key',
      'wnp_live_',
      'wnp_live_tooshort',
      'wnp_staging_' + identifier + secret,
      'other_live_' + identifier + secret,
      'wnp_live_' + identifier + secret + 'extra',
      'wnp_live_' + identifier + secret.slice(1),
      'wnp_live_' + '!'.repeat(apiKeyIdentifierLength + apiKeySecretLength),
    ];

    for (const candidate of rejected) {
      expect(tryParseApiKey(candidate), candidate).toBeUndefined();
    }
  });

  it('rejects a token whose body contains an underscore, which would shift the split', () => {
    const body = '_'.repeat(apiKeyIdentifierLength + apiKeySecretLength);

    expect(tryParseApiKey(`wnp_live_${body}`)).toBeUndefined();
  });
});

describe('parseApiKey', () => {
  it('throws a typed error for a malformed token', () => {
    expect(() => parseApiKey('nonsense')).toThrow(InvalidApiKeyFormatError);
  });

  it('never echoes the supplied token in the error message', () => {
    // An invalid token is still a credential attempt; repeating it risks
    // writing a real key into a log line.
    const attempted = 'wnp_live_thisIsProbablySomeonesRealKeyValue';

    try {
      parseApiKey(attempted);
    } catch (error: unknown) {
      expect((error as Error).message).not.toContain(attempted);
      expect((error as Error).message).not.toContain('thisIsProbably');
    }
  });
});
