import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/live/**/*.live.ts'],
    testTimeout: 30_000,
  },
});
