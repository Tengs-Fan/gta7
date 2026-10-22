import { chromium, defineConfig } from '@playwright/test';
import { currentBrowserLaunch } from './scripts/browserFlags.mjs';

// Hardware GPU through ANGLE (Metal on macOS, Vulkan elsewhere; GTA7_ANGLE overrides); set
// GTA7_SWIFTSHADER=1 on machines without a GPU. On macOS without Playwright's Chromium, the
// installed Google Chrome is used unless GTA7_BROWSER names another executable.
const launch = currentBrowserLaunch(chromium);

// GTA7_PORT lets several checkouts run the suite side by side: with it set, every run builds and
// serves its own checkout (GTA7_REUSE=1 reuses a server already on the port, which must serve
// this checkout). Without it, a running `npm run preview` on 4173 is reused as before.
const port = Number(process.env.GTA7_PORT ?? 4173);
const reuse = process.env.GTA7_PORT ? process.env.GTA7_REUSE === '1' : !process.env.CI;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1280, height: 720 },
    launchOptions: launch,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npm run build && npx vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: reuse,
    timeout: 240_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
