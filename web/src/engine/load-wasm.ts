export type Progress = (loaded: number, total: number) => void;

const CACHE_NAME = "d2sq-engine";

export interface WasmLoad {
  module: WebAssembly.Module;
  cached: boolean;
}

export interface WasmHooks {
  onNetwork: () => void;
  onProgress: Progress;
}

async function openCache(): Promise<Cache | null> {
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

async function lookup(cache: Cache | null, url: string): Promise<Response | null> {
  if (!cache) return null;
  try {
    return (await cache.match(url)) ?? null;
  } catch {
    return null;
  }
}

async function store(cache: Cache | null, url: string, res: Response): Promise<void> {
  if (!cache) return;
  try {
    await cache.put(url, res);
    const current = new URL(url, location.href).href;
    for (const key of await cache.keys()) if (key.url !== current) await cache.delete(key);
  } catch {
    return;
  }
}

function wasmResponse(body: BodyInit | null): Response {
  return new Response(body, { headers: { "content-type": "application/wasm" } });
}

function tracked(res: Response, onProgress: Progress): ReadableStream<Uint8Array> {
  const total = Number(res.headers.get("x-uncompressed-length") ?? res.headers.get("content-length") ?? 0);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  let loaded = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      loaded += value.length;
      onProgress(loaded, total);
      controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

async function compile(res: Response): Promise<WebAssembly.Module> {
  const copy = res.clone();
  try {
    return await WebAssembly.compileStreaming(res);
  } catch {
    return WebAssembly.compile(await copy.arrayBuffer());
  }
}

export async function loadWasm(url: string, hooks: WasmHooks): Promise<WasmLoad> {
  const cache = await openCache();
  const hit = await lookup(cache, url);
  if (hit) {
    try {
      return { module: await compile(wasmResponse(hit.body)), cached: true };
    } catch {
      await cache?.delete(url).catch(() => false);
    }
  }
  hooks.onNetwork();
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Could not load the layout engine (${res.status})`);
  const stream = new Response(tracked(res, hooks.onProgress), { headers: { "content-type": "application/wasm" } });
  const forCache = stream.clone();
  const [module] = await Promise.all([compile(stream), store(cache, url, forCache)]);
  return { module, cached: false };
}
