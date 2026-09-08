import { expect, test } from '@playwright/test';

import { unique } from './support';

/**
 * Which address a request appears to come from is decided by the proxy in
 * front, and getting it wrong is not a visible bug — it is a limiter that
 * quietly meters nobody. Two things have to agree for it to be right: Caddy
 * replacing a client-supplied X-Forwarded-For, and the API trusting only the
 * hop it can see. Only a request that has actually travelled through the proxy
 * exercises both, which is why this lives here rather than in an API test.
 */
test.describe('the per-address sign-in limit', () => {
  test('cannot be evaded by claiming a different address', async ({ request }) => {
    const attempt = async (claimedAddress: string): Promise<number> => {
      const response = await request.post('/dashboard/auth/login', {
        headers: { 'x-forwarded-for': claimedAddress },
        data: { email: `${unique('nobody')}@example.com`, password: 'not-the-password' },
        failOnStatusCode: false,
      });

      return Number(response.headers()['ratelimit-remaining']);
    };

    const first = await attempt('203.0.113.7');
    const second = await attempt('198.51.100.9');

    // A fresh bucket for the second address would mean the header was believed.
    // Both requests came from the same machine, so they share one allowance.
    expect(second).toBeLessThan(first);
  });

  test('leaves creating an account on its own, more generous allowance', async ({ request }) => {
    const signIn = await request.post('/dashboard/auth/login', {
      data: { email: `${unique('nobody')}@example.com`, password: 'not-the-password' },
      failOnStatusCode: false,
    });
    const suffix = unique('limits');
    const registration = await request.post('/dashboard/auth/register', {
      data: {
        organizationName: `Acme ${suffix}`,
        name: 'Dana',
        email: `${suffix}@example.com`,
        password: 'a-long-enough-password',
      },
      failOnStatusCode: false,
    });

    // Sharing one allowance would mean a team signing up together, or this
    // suite, locking itself out for doing something entirely legitimate.
    expect(Number(registration.headers()['ratelimit-limit'])).toBeGreaterThan(
      Number(signIn.headers()['ratelimit-limit']),
    );
  });
});
