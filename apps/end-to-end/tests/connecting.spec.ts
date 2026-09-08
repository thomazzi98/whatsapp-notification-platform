import { expect, test } from '@playwright/test';

import { scanCode, signUpAndCreateApplication } from './support';

test.describe('connecting a WhatsApp account', () => {
  test('offers a code and notices the scan without being asked', async ({ page }) => {
    const tenant = await signUpAndCreateApplication(page);

    await page.getByRole('link', { name: 'Connections' }).click();
    await expect(page.getByText('Nothing connected yet')).toBeVisible();

    await page.getByRole('button', { name: 'Connect an account' }).click();
    await page.getByLabel('Name').fill('Support line');
    await page.getByRole('button', { name: 'Create and show the code' }).click();

    await expect(page.getByRole('heading', { name: 'Scan to connect' })).toBeVisible();
    await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
    // Never "Connected" before the provider says so.
    await expect(page.getByText('Paired with')).toBeHidden();

    const connectionId = page.url().split('/').pop() ?? '';
    await scanCode(connectionId);

    // No reload and no button: the page follows the connection on its own.
    await expect(page.getByText('Paired with +5511999990000')).toBeVisible();
    await expect(page.getByRole('img', { name: /QR code/ })).toBeHidden();
    expect(tenant.applicationId).not.toBe('');
  });

  test('offers stopping rather than starting while a connection is running', async ({ page }) => {
    await signUpAndCreateApplication(page);

    await page.getByRole('link', { name: 'Connections' }).click();
    await page.getByRole('button', { name: 'Connect an account' }).click();
    await page.getByLabel('Name').fill('Order updates');
    await page.getByRole('button', { name: 'Create and show the code' }).click();
    await expect(page.getByRole('heading', { name: 'Scan to connect' })).toBeVisible();

    // An action that cannot succeed is not offered at all.
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start' })).toBeHidden();

    await page.getByRole('button', { name: 'Stop' }).click();

    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
    await expect(page.getByText('Start the connection to bring it back up')).toBeVisible();
  });

  test('warns that notifications will queue while nothing is connected', async ({ page }) => {
    await signUpAndCreateApplication(page);

    await expect(page.getByText('No connected WhatsApp account')).toBeVisible();
    await expect(page.getByText('Notifications created now will queue')).toBeVisible();
  });
});
