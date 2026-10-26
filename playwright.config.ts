import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "apps",
  testMatch: "**/e2e/**/*.spec.ts",
  use: { baseURL: "http://localhost:5173" },
  webServer: {
    command: "pnpm --filter @tether/tracker-client dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
