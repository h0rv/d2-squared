export type Progress = (loaded: number, total: number) => void;

export async function loadWasm(url: string, onProgress: Progress): Promise<WebAssembly.Module> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Could not load the layout engine (${res.status})`);
  const total = Number(res.headers.get("x-uncompressed-length") ?? res.headers.get("content-length") ?? 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return WebAssembly.compile(bytes);
}
