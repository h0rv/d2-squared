import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const out = resolve(root, "web", "public");
mkdirSync(out, { recursive: true });
execFileSync("go", ["build", "-ldflags=-s -w", "-o", resolve(out, "d2squared.wasm"), "./wasm"], {
  cwd: resolve(root, "engine"),
  stdio: "inherit",
  env: { ...process.env, GOOS: "js", GOARCH: "wasm" },
});
