import { expect, test } from '@playwright/test';

import { signUpAndCreateApplication, unique } from './support';

test.describe('creating an account', () => {
  test('says which field is wrong and why, on the field', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByRole('button', { name: 'Create one' }).click();
    await page.getByLabel('Organization').fill('Acme');
    await page.getByLabel('Your name').fill('Dana');
    await page.getByLabel('Email').fill(`${unique('short')}@example.com`);

    // Past the browser's own check, so this exercises what the API said rather
    // than what the markup prevented.
    await page.getByLabel('Password').evaluate((field: HTMLInputElement) => {
      field.minLength = 0;
      field.value = 'short';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.getByRole('button', { name: 'Create account' }).click();

    // The API's own words, against the field they concern. Reading the reason
    // out of the network tab is not an answer.
    await expect(page.getByText('The password must be at least 12 characters.')).toBeVisible();
    // And not the summary, which says only that the body did not match a schema.
    await expect(page.getByText('did not match the expected schema')).toBeHidden();
  });

  test('refuses a short password in the browser, before a round trip', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByRole('button', { name: 'Create one' }).click();

    const password = page.getByLabel('Password');
    await expect(password).toHaveAttribute('minlength', '12');
    await expect(page.getByText('At least 12 characters.')).toBeVisible();
  });
});

test.describe('signing out', () => {
  test('returns to the sign-in screen rather than a page it cannot read', async ({ page }) => {
    await signUpAndCreateApplication(page);

    await page.getByRole('button', { name: 'Sign out' }).click();

    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText('Could not load your applications')).toBeHidden();
  });

  test('leaves nothing readable behind', async ({ page }) => {
    const tenant = await signUpAndCreateApplication(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    // Going straight back to a known URL must not resurrect the session.
    await page.goto(`/applications/${tenant.applicationId}`);

    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});
