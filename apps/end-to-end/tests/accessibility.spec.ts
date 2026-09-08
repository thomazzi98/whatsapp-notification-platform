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

    // Each screen is scanned once its own panel has arrived, not once the
    // shell around it has. Scanning mid-render measures a state nobody sees,
    // and reports something neither true nor reproducible.
    const screens = [
      { path: base, settled: 'Recent notifications' },
      { path: `${base}/notifications`, settled: 'Filters' },
      { path: `${base}/send`, settled: 'Send a notification' },
      { path: `${base}/connections`, settled: 'WhatsApp connections' },
    ];

    for (const screen of screens) {
      await page.goto(screen.path);
      await expect(page.getByRole('heading', { name: screen.settled })).toBeVisible();
      await scan(page);
    }
  });
});
