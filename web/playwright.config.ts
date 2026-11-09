import { defineConfig, devices } from "@playwright/test";

const viewport = { width: 1500, height: 950 };
const channel = process.env["PW_CHANNEL"];
const chromium = channel ? { channel } : {};
const firefox = { ...devices["Desktop Firefox"], viewport };
const baseURL = "http://127.0.0.1:8807";

export default defineConfig({
  testDir: "tests",
  timeout: 180_000,
  workers: 1,
  outputDir: "test-results/pw",
  reporter: [["list"]],
  use: { viewport },
  projects: [
    { name: "wasm", testMatch: ["wasm.spec.ts", "engines.spec.ts"], use: { baseURL, ...chromium } },
    { name: "serve", testMatch: "serve.spec.ts", use: chromium },
    { name: "wasm-firefox", testMatch: ["wasm.spec.ts", "engines.spec.ts"], use: { ...firefox, baseURL } },
    { name: "serve-firefox", testMatch: "serve.spec.ts", use: firefox },
  ],
  webServer: {
    command: "npx vite preview --host 127.0.0.1 --port 8807 --strictPort",
    url: "http://127.0.0.1:8807/d2-squared/",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
