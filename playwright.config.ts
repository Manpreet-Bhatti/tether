import { defineConfig } from "@playwright/test";

process.env.JWT_SECRET = "e2e-secret-e2e-secret-e2e-secret-!!";

export default defineConfig({
  testDir: "apps",
  testMatch: "**/e2e/**/*.spec.ts",
  use: { baseURL: "http://localhost:5173" },
  webServer: [
    {
      command: "pnpm --filter @tether/tracker-client dev",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
    },
    {
      // Needs Postgres: `pnpm db:up` locally, a service container in CI.
      command: "pnpm --filter @tether/tracker-server start",
      port: 8787,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
