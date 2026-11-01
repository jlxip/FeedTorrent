import { firefoxOptions } from "./tests/firefox.mjs";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testMatch: "*.spec.ts",
  timeout: 180000,
  expect: { timeout: 60000 },
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
    {
      name: "firefox",
      use: { browserName: "firefox", launchOptions: firefoxOptions() },
    },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
