import {runRoot,isolatedUIFiles} from './tests/runtime.mjs';
import {join} from 'node:path';
import { firefoxOptions } from "./tests/firefox.mjs";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testMatch: process.env.FEEDTORRENT_UI_POOL === 'isolated' ? isolatedUIFiles : '*.spec.ts',
  fullyParallel: process.env.FEEDTORRENT_UI_POOL === 'isolated',
  timeout: 180000,
  expect: { timeout: 60000 },
  workers: process.env.FEEDTORRENT_UI_POOL === 'isolated' ? 2 : 1,
  retries: 0,
  outputDir: join(runRoot, `${process.env.FEEDTORRENT_UI_POOL || 'serial'}-artifacts`),
  reporter: [["list"], ["json", { outputFile: join(runRoot, `${process.env.FEEDTORRENT_UI_POOL || 'serial'}-results.json`) }]],
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
    {
      name: "firefox", testIgnore: "**/publication-live.spec.ts",
      use: { browserName: "firefox", launchOptions: firefoxOptions() },
    },
    { name: "webkit", testIgnore: "**/publication-live.spec.ts", use: { browserName: "webkit" } },
  ],
});
