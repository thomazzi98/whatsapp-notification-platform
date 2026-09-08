import { defineConfig, devices } from '@playwright/test';

/**
 * The address the dashboard is served on, which is also the API's origin. The
 * suite never talks to the API on its own port: the point is to exercise what a
 * person's browser actually does.
 */
const DASHBOARD_URL = process.env.E2E_DASHBOARD_URL ?? 'http://127.0.0.1:8080';

/** The provider stub's control plane, which stands in for a phone. */
export const STUB_URL = process.env.E2E_STUB_URL ?? 'http://127.0.0.1:3200';

export default defineConfig({
  testDir: './tests',
  // Every wait is an auto-retrying assertion rather than a sleep, so this is a
  // ceiling for a genuinely stuck test rather than a budget anything spends.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Delivery is asynchronous and shared: two specs sending at once would
  // contend for the same session's pacing window and make each other slow.
  workers: 1,
  fullyParallel: false,
  // A retry hides a flake rather than fixing it, and this suite is small enough
  // that a failure is worth reading rather than re-rolling.
  retries: 0,
  reporter: process.env.CI === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: DASHBOARD_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
