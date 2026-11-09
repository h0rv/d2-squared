import "../wasm_exec.js";

type Incoming = { type: "init"; module: WebAssembly.Module } | { type: "call"; id: number; op: keyof D2SquaredApi; args: unknown[] };

const ready = new Promise<void>((resolve) => {
  globalThis.d2squaredReady = resolve;
});

async function boot(module: WebAssembly.Module): Promise<void> {
  const go = new Go();
  const instance = await WebAssembly.instantiate(module, go.importObject);
  void go.run(instance);
  await ready;
  self.postMessage({ type: "ready" });
}

async function call(id: number, op: keyof D2SquaredApi, args: unknown[]): Promise<void> {
  await ready;
  try {
    const fn = d2squared[op] as (...a: unknown[]) => Promise<string>;
    const raw = await fn.apply(d2squared, args);
    self.postMessage({ type: "result", id, ok: true, result: JSON.parse(raw) as unknown });
  } catch (err) {
    self.postMessage({ type: "result", id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

self.onmessage = (event: MessageEvent<Incoming>) => {
  const msg = event.data;
  if (msg.type === "init") void boot(msg.module);
  else void call(msg.id, msg.op, msg.args);
};
