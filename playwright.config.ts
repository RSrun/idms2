import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  // engine.test.ts bağımsız bir script (scripts/test-engine.mjs ile koşar),
  // Playwright senaryosu değildir → yalnızca *.spec.ts dosyaları toplanır.
  testMatch: '**/*.spec.ts',
  testIgnore: ['**/.build/**', '**/*.test.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium-extension',
      use: {
        ...devices['Desktop Chrome'],
        // Eklenti yüklemesi yalnızca tam Chromium (new headless) ile çalışır;
        // varsayılan headless-shell `--load-extension`'ı yok sayar.
        channel: 'chromium',
        launchOptions: {
          args: [
            `--disable-extensions-except=${process.cwd()}/extension/chromium`,
            `--load-extension=${process.cwd()}/extension/chromium`,
          ],
        },
      },
    },
    {
      name: 'gecko-extension',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            // UUID, manifest'teki gecko kimliğiyle aynı olmalı
            'extensions.webextensions.uuids': '{"idms2@idms2.app":"test-uuid"}',
          },
        },
      },
    },
  ],
});


