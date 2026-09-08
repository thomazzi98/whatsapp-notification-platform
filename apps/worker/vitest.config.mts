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
          // The dispatch suite drives one shared database and one shared queue.
          // Running its files in parallel would have them competing for the
          // same jobs, which is the behaviour under test in exactly one file.
          fileParallelism: false,
        },
      },
    ],
  },
});
