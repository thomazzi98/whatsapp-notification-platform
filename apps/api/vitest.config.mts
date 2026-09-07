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
          // Bootstrapping a Nest module is slow enough that the default five
          // second timeout is flaky when the whole workspace builds in parallel.
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.integration.test.ts'],
          globalSetup: ['./testing/global-setup.ts'],
          hookTimeout: 180_000,
          testTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
