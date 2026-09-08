import { expect, test } from '@playwright/test';

import {
  acknowledge,
  connectWhatsApp,
  readProviderMessageId,
  recipients,
  sendNotification,
  signUpAndCreateApplication,
} from './support';

test.describe('delivering a notification', () => {
  test('goes from accepted to delivered as WhatsApp reports back', async ({ page }) => {
    await signUpAndCreateApplication(page);
    const connectionId = await connectWhatsApp(page);

    await sendNotification(page, recipients.healthy, 'Your order #4821 has shipped.');

    // Accepted, not delivered. The distinction is the product.
    await expect(page.getByText('Accepted and waiting for a worker')).toBeVisible();

    await expect(page.getByText('WhatsApp accepted it')).toBeVisible({ timeout: 30_000 });
    const providerMessageId = await readProviderMessageId(page);

    await acknowledge(connectionId, providerMessageId, 2);

    await expect(page.getByText("It reached the recipient's device")).toBeVisible();
    await expect(page.getByText('No read receipt')).toBeVisible();
  });

  test('records a read receipt without changing the status, because delivered is terminal', async ({
    page,
  }) => {
    await signUpAndCreateApplication(page);
    const connectionId = await connectWhatsApp(page);

    await sendNotification(page, recipients.healthy, 'Your order is out for delivery.');
    const providerMessageId = await readProviderMessageId(page);

    await acknowledge(connectionId, providerMessageId, 2);
    await expect(page.getByText("It reached the recipient's device")).toBeVisible();

    await acknowledge(connectionId, providerMessageId, 3);

    await expect(page.getByText('No read receipt')).toBeHidden();
    await expect(page.getByText("It reached the recipient's device")).toBeVisible();
  });

  test('fails a number that is not on WhatsApp, without spending an attempt', async ({ page }) => {
    await signUpAndCreateApplication(page);
    await connectWhatsApp(page);

    await sendNotification(page, recipients.notOnWhatsApp, 'This will not arrive.');

    await expect(page.getByText('It will not be attempted again')).toBeVisible({ timeout: 30_000 });
    // The alert, not the timeline entry: both carry the code, and the alert is
    // the one a person reads first.
    await expect(page.getByRole('alert')).toContainText('recipient_not_on_whatsapp');
    // Nothing was sent, so nothing was charged.
    await expect(page.getByText('0 of 5', { exact: true })).toBeVisible();
  });

  test('schedules another attempt after a provider error', async ({ page }) => {
    await signUpAndCreateApplication(page);
    await connectWhatsApp(page);

    await sendNotification(page, recipients.serverError, 'The provider will refuse this once.');

    await expect(page.getByText('An attempt did not succeed and another is scheduled')).toBeVisible(
      {
        timeout: 30_000,
      },
    );
    await expect(page.getByRole('alert')).toContainText('provider_server_error');
    // Exact, so this reads the attempt counter rather than the timeline's
    // "Attempt 1 of 5" heading.
    await expect(page.getByText('1 of 5', { exact: true })).toBeVisible();
  });

  test('shows the notification in the list, filtered by status', async ({ page }) => {
    await signUpAndCreateApplication(page);
    await connectWhatsApp(page);
    await sendNotification(page, recipients.healthy, 'Listed and filterable.');
    await expect(page.getByText('WhatsApp accepted it')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('link', { name: 'Notifications', exact: true }).click();
    await expect(page.getByRole('cell', { name: recipients.healthy })).toBeVisible();

    await page.getByLabel('Status').selectOption('FAILED');
    await expect(page.getByText('No notifications match these filters yet')).toBeVisible();

    await page.getByLabel('Status').selectOption('SENT');
    await expect(page.getByRole('cell', { name: recipients.healthy })).toBeVisible();
  });
});
