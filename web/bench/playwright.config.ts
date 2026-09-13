import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  timeout: 480_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    launchOptions: { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] },
  },
  webServer: {
    command: 'pnpm vite preview --port 4317 --strictPort',
    url: 'http://localhost:4317',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
