import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { signUpAndCreateApplication } from './support';

/**
 * The same engine the component tests use, in a real browser.
 *
 * That is the point of running it here as well rather than only there: the
 * rules that matter most to somebody actually using this — colour contrast,
 * landmarks, focus order — need layout, and jsdom has none. A component test
 * can only answer whether the markup is labelled correctly.
 */
async function scan(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(
    results.violations.flatMap((violation) =>
      violation.nodes.map(
        (node) => `${violation.id}: ${node.target.join(' ')} -- ${node.failureSummary ?? ''}`,
      ),
    ),
  ).toEqual([]);
}

test.describe('every screen a person lands on', () => {
  test('passes an accessibility scan before signing in', async ({ page }) => {
    await page.goto('/sign-in');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    await scan(page);
  });

  test('passes an accessibility scan on the screens behind sign-in', async ({ page }) => {
    const tenant = await signUpAndCreateApplication(page);
    const base = `/applications/${tenant.applicationId}`;

    for (const path of [base, `${base}/notifications`, `${base}/send`, `${base}/connections`]) {
      await page.goto(path);
      // The heading is the signal the route finished rather than a fixed wait.
      await expect(page.getByRole('heading').first()).toBeVisible();
      await scan(page);
    }
  });
});
