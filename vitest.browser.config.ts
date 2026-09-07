import { defineConfig } from 'vitest/config';

/**
 * The GPU tests: what needs a WebGPU device, run headless in the machine's
 * Chrome rather than in node, which has no WebGPU. `npm run test:gpu`.
 */
export default defineConfig({
  // a test may write frames out for looking at, to a directory given in VITE_FRAME_DIR
  server: { fs: { strict: false } },
  test: {
    include: ['src/**/*.gpu.test.ts'],
    testTimeout: 30_000,
    browser: {
      enabled: true,
      headless: true,
      provider: 'playwright',
      screenshotFailures: false,
      instances: [{
        browser: 'chromium',
        // the installed Chrome, so nothing is downloaded; WebGPU is behind a flag when headless
        launch: { channel: 'chrome', args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist'] },
      }],
    },
  },
});
