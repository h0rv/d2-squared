import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const wasm = resolve(import.meta.dirname, "public/d2squared.wasm");

export default defineConfig(({ mode }) => {
  const embed = mode === "embed";
  const names = {
    entryFileNames: "assets/[name].js",
    chunkFileNames: "assets/[name].js",
    assetFileNames: "assets/[name][extname]",
  };
  return {
    base: embed ? "./" : (process.env["D2_BASE"] ?? "/d2-squared/"),
    publicDir: embed ? false : "public",
    define: { WASM_BYTES: existsSync(wasm) ? statSync(wasm).size : 0 },
    worker: { format: "es", ...(embed ? { rollupOptions: { output: names } } : {}) },
    build: {
      target: "es2022",
      outDir: embed ? resolve(import.meta.dirname, "../engine/cmd/d2squared/ui") : "dist",
      emptyOutDir: true,
      chunkSizeWarningLimit: 600,
      ...(embed ? { rollupOptions: { output: names } } : {}),
    },
    server: { port: 8801, strictPort: true },
    preview: { port: 8802, strictPort: true },
  };
});
