import { defineConfig, devices } from "@playwright/test";

// A smoke test of both languages against a production build that reads the real database
// (MONGODB_URI from the repo-root .env). It changes nothing; run with `npm run test:e2e`.
export default defineConfig({
  testDir: "e2e",
  reporter: "list",
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    // AUTH_TRUST_HOST: Auth.js trusts Vercel's host by itself, not localhost.
    command: "npm run build && AUTH_TRUST_HOST=true npm run start -- -p 3100",
    url: "http://localhost:3100/ru",
    reuseExistingServer: true,
    timeout: 240_000,
  },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
});
