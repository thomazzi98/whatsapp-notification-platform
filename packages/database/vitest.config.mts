import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.integration.test.ts'],
          globalSetup: ['./testing/global-setup.ts'],
          // Pulling and starting Postgres dominates the first run.
          hookTimeout: 180_000,
          testTimeout: 60_000,
          // A single shared database means files must not run concurrently.
          fileParallelism: false,
        },
      },
    ],
  },
});
