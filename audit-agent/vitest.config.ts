import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Setup hooks launch real Chromium and load the real Design System registry; with every
    // browser-backed file running in parallel, 10s is too tight a default for that.
    hookTimeout: 120_000,
  },
});
