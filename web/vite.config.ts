import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const publicDir = resolve(import.meta.dirname, "public");

function builtWasm(): { name: string; bytes: number } | null {
  const name = readdirSync(publicDir, { withFileTypes: true })
    .map((entry) => entry.name)
    .find((file) => /^d2squared\.[0-9a-f]+\.wasm$/.test(file));
  return name ? { name, bytes: statSync(resolve(publicDir, name)).size } : null;
}

export default defineConfig(({ mode }) => {
  const embed = mode === "embed";
  const base = embed ? "./" : (process.env["D2_BASE"] ?? "/d2-squared/");
  const wasm = embed ? null : builtWasm();
  const names = {
    entryFileNames: "assets/[name].js",
    chunkFileNames: "assets/[name].js",
    assetFileNames: "assets/[name][extname]",
  };
  return {
    base,
    publicDir: embed ? false : "public",
    define: {
      WASM_BYTES: wasm?.bytes ?? 0,
      WASM_URL: JSON.stringify(wasm ? `${base}${wasm.name}` : ""),
    },
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
