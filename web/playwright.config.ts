import { defineConfig } from "@playwright/test";

const channel = process.env["PW_CHANNEL"];

export default defineConfig({
  testDir: "tests",
  timeout: 180_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    viewport: { width: 1500, height: 950 },
    ...(channel ? { channel } : {}),
  },
  projects: [
    { name: "wasm", testMatch: "wasm.spec.ts", use: { baseURL: "http://127.0.0.1:8802" } },
    { name: "serve", testMatch: "serve.spec.ts" },
  ],
  webServer: {
    command: "npx vite preview --host 127.0.0.1 --port 8802 --strictPort",
    url: "http://127.0.0.1:8802/d2-squared/",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
