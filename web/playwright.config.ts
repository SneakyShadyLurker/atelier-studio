import { existsSync } from 'node:fs';
import { defineConfig, devices, firefox } from '@playwright/test';

// Firefox joins the anchor lane whenever its build is installed. When it is
// not, say so once per run instead of failing to launch it, so a missing
// engine is a recorded verification gap rather than a silent skip.
const firefoxInstalled = existsSync(firefox.executablePath());
if (!firefoxInstalled) {
  console.warn(`[playwright] Firefox is not installed (${firefox.executablePath()}): the firefox-anchors project is unavailable, so native-anchors.spec.ts runs without Firefox this time.`);
}

// Real-browser lane. happy-dom (the unit-test substrate) implements neither the
// top layer nor light dismiss — `dialog.matches(':modal')` is false and
// `showPopover` is undefined there — so behaviour we hand to the platform can
// only be regression-tested here.
export default defineConfig({
  testDir: './e2e',
  // Deliberately serial. These specs assert frame-accurate scroll behaviour —
  // where a follow lands, whether a row shifts — and eight browsers competing
  // for CPU perturbs exactly the thing under test, producing failures that say
  // nothing about the product. Keep the geometry lane deterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'line' : [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: {
      mode: 'retain-on-failure',
      snapshots: { dom: true, aria: true, screen: true },
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit-ui', use: { ...devices['Desktop Safari'] }, testMatch: '**/ui-polish.spec.ts' },
    // Native CSS anchor positioning and popovers are resolved by each engine
    // independently, so their behaviour lane runs on every installed one.
    // Unrelated specs and pixel baselines stay Chromium-only.
    ...(firefoxInstalled
      ? [{ name: 'firefox-anchors', use: { ...devices['Desktop Firefox'] }, testMatch: '**/native-anchors.spec.ts' }]
      : []),
    { name: 'webkit-anchors', use: { ...devices['Desktop Safari'] }, testMatch: '**/native-anchors.spec.ts' },
  ],
  // The overlay harness (e2e/harness/) is a dev-server-only entry, so the specs
  // need Vite running — not a built bundle. No API is involved.
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:5173/e2e/harness/index.html',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
