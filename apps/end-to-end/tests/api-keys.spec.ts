import { expect, type Page, test } from '@playwright/test';

import { connectWhatsApp, recipients, signUpAndCreateApplication, unique } from './support';

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3100';

/** Creates a key through the screens and returns the one-time plaintext value. */
async function createKeyThroughTheDashboard(page: Page): Promise<string> {
  await page.getByRole('link', { name: 'API keys' }).click();
  await page.getByLabel('Name').fill(unique('service'));
  await page.getByRole('button', { name: 'Create key' }).click();

  return (
    (await page
      .getByText(/^wnp_(test|live)_/)
      .first()
      .textContent()) ?? ''
  );
}

test.describe('API keys', () => {
  test('shows a usable key once, and never again', async ({ page }) => {
    await signUpAndCreateApplication(page);

    await page.getByRole('link', { name: 'API keys' }).click();
    await page.getByLabel('Name').fill('orders-service');
    await page.getByRole('button', { name: 'Create key' }).click();

    await expect(page.getByText('Copy this key now')).toBeVisible();
    const key =
      (await page
        .getByText(/^wnp_(test|live)_/)
        .first()
        .textContent()) ?? '';
    expect(key).toMatch(/^wnp_(test|live)_[A-Za-z0-9]{44}$/);

    await page.getByRole('button', { name: 'I have saved it' }).click();
    await expect(page.getByText('Copy this key now')).toBeHidden();

    // Reloading is the obvious thing someone does after losing a key, and it
    // has to be honest: the platform stores a hash and cannot show it again.
    await page.reload();
    await expect(page.getByText(key)).toBeHidden();

    // The truncated form stays, so a key can still be recognised in a list.
    await expect(page.getByText(key.slice(0, 20))).toBeVisible();
  });

  test('authenticates the public API, and reaches only its own application', async ({
    page,
    request,
  }) => {
    await signUpAndCreateApplication(page);
    // An application with nothing connected answers 409 rather than accepting a
    // notification it could never deliver, so the connection comes first.
    await connectWhatsApp(page);

    await page.getByRole('link', { name: 'API keys' }).click();
    await page.getByLabel('Name').fill('orders-service');
    await page.getByRole('button', { name: 'Create key' }).click();
    const key =
      (await page
        .getByText(/^wnp_(test|live)_/)
        .first()
        .textContent()) ?? '';

    const accepted = await request.post(`${API_URL}/v1/notifications`, {
      headers: { authorization: `Bearer ${key}` },
      data: { recipient: recipients.healthy, body: 'Sent with an API key.' },
    });

    // 202: persisted and queued, not delivered.
    expect(accepted.status()).toBe(202);

    const rejected = await request.post(`${API_URL}/v1/notifications`, {
      headers: { authorization: 'Bearer wnp_test_notarealkey0000000000000000000000000000' },
      data: { recipient: recipients.healthy, body: 'This should not be accepted.' },
    });

    expect(rejected.status()).toBe(401);
  });

  test("cannot read another tenant's notification, with a real key", async ({ page, request }) => {
    // The negative case above uses a key that never existed, which proves only
    // that the parser rejects nonsense. Tenant isolation is a different claim:
    // a real, valid, active key must not reach a real notification belonging to
    // somebody else. Nothing tested that end to end.
    await signUpAndCreateApplication(page);
    await connectWhatsApp(page);
    const firstKey = await createKeyThroughTheDashboard(page);

    const created = await request.post(`${API_URL}/v1/notifications`, {
      headers: { authorization: `Bearer ${firstKey}` },
      data: { recipient: recipients.healthy, body: "The other tenant's message." },
    });
    const notificationId = ((await created.json()) as { id: string }).id;

    // A second organisation, in a fresh browser context, with its own key.
    await page.context().clearCookies();
    await signUpAndCreateApplication(page);
    await connectWhatsApp(page);
    const secondKey = await createKeyThroughTheDashboard(page);

    const refused = await request.get(`${API_URL}/v1/notifications/${notificationId}`, {
      headers: { authorization: `Bearer ${secondKey}` },
      failOnStatusCode: false,
    });

    // 404 rather than 403: the API does not confirm that the identifier exists.
    expect(created.status()).toBe(202);
    expect(refused.status()).toBe(404);
  });

  test('stops working the moment it is revoked', async ({ page, request }) => {
    await signUpAndCreateApplication(page);

    await page.getByRole('link', { name: 'API keys' }).click();
    await page.getByLabel('Name').fill('temporary');
    await page.getByRole('button', { name: 'Create key' }).click();
    const key =
      (await page
        .getByText(/^wnp_(test|live)_/)
        .first()
        .textContent()) ?? '';
    await page.getByRole('button', { name: 'I have saved it' }).click();

    await page.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText('Revoked')).toBeVisible();

    const response = await request.get(`${API_URL}/v1/notifications`, {
      headers: { authorization: `Bearer ${key}` },
    });

    expect(response.status()).toBe(401);
  });
});
