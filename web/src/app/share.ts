const PREFIX = "#s=";

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function encodeShare(source: string): Promise<string> {
  const packed = await pipe(new TextEncoder().encode(source), new CompressionStream("deflate-raw"));
  return PREFIX + toBase64Url(packed);
}

export async function decodeShare(hash: string): Promise<string | null> {
  if (!hash.startsWith(PREFIX)) return null;
  try {
    const raw = await pipe(fromBase64Url(hash.slice(PREFIX.length)), new DecompressionStream("deflate-raw"));
    return new TextDecoder().decode(raw);
  } catch {
    return null;
  }
}
