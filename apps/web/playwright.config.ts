import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Browser smoke tests for the isolated Chat Lab (docs/testing.md#chat-lab-smoke).
// The Vite lab server is started here with a throwaway HOME; it has no backend,
// and every page blocks requests that leave the lab origin.
const port = Number(process.env.COCKPIT_LAB_SMOKE_PORT ?? 47851);
const home = mkdtempSync(join(tmpdir(), 'cockpit-lab-smoke-'));
const labOrigin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/chat-lab',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : 1,
  timeout: 30_000,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: labOrigin,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'narrow', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${labOrigin}/chat-lab.html`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      COCKPIT_CHAT_LAB: '1', HOME: home, COCKPIT_HOME: join(home, '.cockpit'), COPILOT_HOME: join(home, '.copilot'),
      COCKPIT_LAB_FILE_ROOT: '', COCKPIT_LAB_SPEECH_ROOT: '',
    },
  },
});
