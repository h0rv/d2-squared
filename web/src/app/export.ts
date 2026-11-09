import type { Engine } from "../engine/engine";
import { unicodePreferred } from "../ui/textview";

export type ExportKind = "svg" | "png" | "text";

const SCALE = 2;
const DARK_BACKGROUND = "#0a0a23";

export function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function sizeOf(svg: string): { width: number; height: number } {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const box = (root.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
  const width = Number(root.getAttribute("width")) || box[2] || 0;
  const height = Number(root.getAttribute("height")) || box[3] || 0;
  if (!(width > 0 && height > 0)) throw new Error("The diagram has no size to export.");
  return { width, height };
}

async function rasterize(svg: string, dark: boolean): Promise<Blob> {
  const { width, height } = sizeOf(svg);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.width = width;
    image.height = height;
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * SCALE);
    canvas.height = Math.ceil(height * SCALE);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser can't draw the picture.");
    ctx.fillStyle = dark ? DARK_BACKGROUND : "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The picture could not be saved."))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function exportAs(kind: ExportKind, engine: Engine, name: string): Promise<string> {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  if (kind === "text") {
    const { text } = await engine.text(unicodePreferred());
    download(`${name}.txt`, new Blob([text], { type: "text/plain;charset=utf-8" }));
    return "Exported as text";
  }
  const svg = await engine.exportSvg(dark);
  if (kind === "svg") {
    download(`${name}.svg`, new Blob([svg], { type: "image/svg+xml" }));
    return "Exported as SVG";
  }
  download(`${name}.png`, await rasterize(svg, dark));
  return "Exported as PNG";
}
