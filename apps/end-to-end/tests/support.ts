import { expect, type Page } from '@playwright/test';

import { STUB_URL } from '../playwright.config';

/**
 * Recipient suffixes the provider stub reacts to, so a failure path is a
 * property of the number rather than of global state — which is what lets these
 * specs run without resetting the provider between them.
 */
export const recipients = {
  healthy: '+5511988887777',
  notOnWhatsApp: '+5511999990404',
  serverError: '+5511999990500',
} as const;

/**
 * Unique per call, so a rerun against a stack that was not torn down still
 * passes: registration refuses a repeated email address, correctly.
 */
export function unique(prefix: string): string {
  return `${prefix}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface Tenant {
  readonly applicationId: string;
  readonly applicationName: string;
}

/**
 * Registers an account and creates an application, entirely through the UI.
 *
 * Seeding the database directly would be faster and would test less: the point
 * of this suite is that the screens a person uses actually work together.
 */
export async function signUpAndCreateApplication(page: Page): Promise<Tenant> {
  const suffix = unique('e2e');
  const applicationName = `Store ${suffix}`;

  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Create one' }).click();
  await page.getByLabel('Organization').fill(`Acme ${suffix}`);
  await page.getByLabel('Your name').fill('Dana');
  await page.getByLabel('Email').fill(`${suffix}@example.com`);
  await page.getByLabel('Password').fill('a-long-enough-password');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Applications', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'New application' }).click();
  await page.getByLabel('Name').fill(applicationName);
  await page.getByRole('button', { name: 'Create application' }).click();

  const applicationLink = page.getByRole('link', { name: applicationName });
  await expect(applicationLink).toBeVisible();
  await applicationLink.click();

  await expect(page).toHaveURL(/\/applications\/[0-9a-f-]{36}$/);
  const applicationId = page.url().split('/').pop() ?? '';

  return { applicationId, applicationName };
}

/**
 * Creates a WhatsApp connection through the dashboard and pairs it.
 *
 * The scan is the one step a person with a phone would perform, so the stub's
 * control plane performs it — everything either side of that is the real path.
 */
export async function connectWhatsApp(page: Page): Promise<string> {
  await page.getByRole('link', { name: 'Connections' }).click();
  await page.getByRole('button', { name: 'Connect an account' }).click();
  await page.getByLabel('Name').fill('Order updates');
  await page.getByRole('button', { name: 'Create and show the code' }).click();

  await expect(page.getByRole('heading', { name: 'Scan to connect' })).toBeVisible();
  const connectionId = page.url().split('/').pop() ?? '';

  await scanCode(connectionId);

  // No reload: the page notices on its own, which is the behaviour under test.
  await expect(page.getByText('Paired with')).toBeVisible();

  return connectionId;
}

async function requestStub(path: string, body: unknown): Promise<Response> {
  const response = await fetch(`${STUB_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`The provider stub refused ${path}: ${String(response.status)}`);
  }
  return response;
}

/** Stands in for a person scanning the code with a phone. */
export async function scanCode(connectionId: string): Promise<void> {
  await requestStub(`/__stub/sessions/wnp-${connectionId}/scan`, {
    phoneNumber: '5511999990000',
  });
}

/** Stands in for WhatsApp reporting what became of a message. */
export async function acknowledge(
  connectionId: string,
  providerMessageId: string,
  acknowledgement: number,
): Promise<void> {
  await requestStub(`/__stub/sessions/wnp-${connectionId}/acknowledge`, {
    messageId: providerMessageId,
    ack: acknowledgement,
  });
}

export async function sendNotification(page: Page, recipient: string, body: string): Promise<void> {
  await page.getByRole('link', { name: 'Send', exact: true }).click();
  await page.getByLabel('Recipient').fill(recipient);
  await page.getByLabel('Message').fill(body);
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  // Sending lands on the delivery page, not on a success banner: the API
  // accepted the message and nobody has received it yet.
  await expect(page.getByRole('heading', { name: 'Notification' })).toBeVisible();
}

/**
 * The identifier the provider gave the message, once the worker has sent it.
 *
 * Read from the field that describes it rather than by matching the shape of
 * the string: the shape is the provider's business and has already changed
 * once, and a test that encodes it fails for reasons that are not about the
 * platform.
 */
export async function readProviderMessageId(page: Page): Promise<string> {
  const value = page
    .locator('dt', { hasText: 'Provider message' })
    .locator('xpath=following-sibling::dd[1]');

  await expect(value).not.toHaveText('—', { timeout: 30_000 });

  return ((await value.textContent()) ?? '').trim();
}
