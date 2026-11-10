import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const out = resolve(root, "web", "public");
mkdirSync(out, { recursive: true });
for (const name of readdirSync(out)) if (/^d2squared(\..+)?\.wasm$/.test(name)) rmSync(resolve(out, name));

const built = resolve(out, "d2squared.wasm");
execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", built, "./wasm"], {
  cwd: resolve(root, "engine"),
  stdio: "inherit",
  env: { ...process.env, GOOS: "js", GOARCH: "wasm" },
});

const hash = createHash("sha256").update(readFileSync(built)).digest("hex").slice(0, 10);
renameSync(built, resolve(out, `d2squared.${hash}.wasm`));
