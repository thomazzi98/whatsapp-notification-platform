import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * jsdom rather than a real browser. These tests answer "does this component say
 * the right thing in this state" — which a browser makes slower without making
 * more truthful. The questions that genuinely need a browser, and a real API
 * behind it, are in the end-to-end suite.
 *
 * Tailwind is deliberately absent: nothing here asserts on appearance, and
 * compiling a stylesheet for every run would buy nothing.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['./testing/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/main.tsx'],
    },
  },
});
