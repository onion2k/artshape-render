import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // the GPU tests want a browser: vitest.browser.config.ts
    exclude: ['**/node_modules/**', '**/*.gpu.test.ts'],
  },
});
