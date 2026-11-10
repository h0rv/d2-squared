import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import path from "node:path";
import { chromium } from "@playwright/test";
import gifenc from "gifenc";

const { GIFEncoder, applyPalette, quantize } = gifenc;
const PORT = 8809;
const URL = `http://127.0.0.1:${PORT}/d2-squared/`;
const WIDTH = 1200;
const HEIGHT = 700;
const out = path.resolve(import.meta.dirname, "../../docs/demo.gif");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const root = path.resolve(import.meta.dirname, "..");
const server = spawn(
  process.execPath,
  [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  {
    cwd: root,
    stdio: "ignore",
  },
);

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error("the preview server did not start");
}

const cursor = () => {
  document.addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.style.cssText =
      "position:fixed;left:0;top:0;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:rgba(20,24,36,.4);border:2px solid #fff;box-shadow:0 0 0 1px rgba(20,24,36,.6);pointer-events:none;z-index:2147483647;display:none;transition:background .08s,transform .08s";
    document.body.append(dot);
    let x = 0;
    let y = 0;
    let scale = 1;
    const paint = () => {
      dot.style.display = "block";
      dot.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
      dot.style.background = scale < 1 ? "rgba(20,24,36,.8)" : "rgba(20,24,36,.4)";
    };
    addEventListener(
      "pointermove",
      (e) => {
        x = e.clientX;
        y = e.clientY;
        paint();
      },
      true,
    );
    addEventListener("pointerdown", () => ((scale = 0.7), paint()), true);
    addEventListener("pointerup", () => ((scale = 1), paint()), true);
  });
};

const SOURCE = readFileSync(path.resolve(import.meta.dirname, "../../examples/architecture.d2"), "utf8")
  .replace("  notifier: Notifier\n", "")
  .replace("  queue: Event bus {shape: queue}\n", "  queue: Event bus {shape: queue}\n  notifier: Notifier\n")
  .replace("services.orders -> data.db", "services.orders -> data.cache")
  .replace("data.queue -> services.notifier", "data.queue -> data.notifier");
const hash = "#s=" + deflateRawSync(Buffer.from(SOURCE)).toString("base64url");

async function main() {
  await waitForServer();
  const browser = await chromium.launch({ channel: process.env["PW_CHANNEL"] || undefined });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: "light", deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem("d2sq.hint", "1"));
  await context.addInitScript(cursor);
  const page = await context.newPage();
  const decoder = await context.newPage();
  await page.goto(URL + hash);
  await page.waitForFunction(
    () => !!window.editor?.view?.scene && !!document.body.dataset["ready"] && !document.getElementById("loading")?.offsetParent,
  );
  const pan = await page.evaluate(() => {
    const e = window.editor;
    const a = e.shape("services");
    const b = e.shape("data");
    const x0 = Math.min(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x + a.width, b.x + b.width);
    const y1 = Math.max(a.y + a.height, b.y + b.height);
    e.setScale(Math.min(1080 / (x1 - x0), 560 / (y1 - y0)));
    const mid = e.screenPoint((x0 + x1) / 2, (y0 + y1) / 2);
    return { x: innerWidth / 2 - mid.x, y: innerHeight / 2 + 28 - mid.y };
  });
  await page.mouse.move(WIDTH / 2, HEIGHT / 2);
  await page.mouse.wheel(-pan.x, -pan.y);
  await sleep(500);
  await page.mouse.move(WIDTH - 140, HEIGHT - 110);
  await sleep(300);

  const frames = [];
  const session = await context.newCDPSession(page);
  session.on("Page.screencastFrame", (frame) => {
    frames.push({ at: frame.metadata.timestamp * 1000, jpeg: Buffer.from(frame.data, "base64") });
    void session.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });

  const center = (id) => page.evaluate((i) => window.editor.screenCenter(i), id);
  const inside = (id) =>
    page.evaluate((i) => {
      const s = window.editor.shape(i);
      return window.editor.screenPoint(s.x + s.width / 2, s.y + s.height - 12 / window.editor.scale);
    }, id);
  let pointer = { x: WIDTH - 140, y: HEIGHT - 110 };
  const glide = async (to, ms) => {
    const from = pointer;
    const started = Date.now();
    for (;;) {
      const t = Math.min(1, (Date.now() - started) / ms);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      await page.mouse.move(from.x + (to.x - from.x) * ease, from.y + (to.y - from.y) * ease);
      if (t >= 1) break;
    }
    pointer = to;
  };
  const toast = (text) => page.waitForFunction((t) => document.getElementById("toast")?.textContent?.includes(t), text);

  await sleep(700);
  const notifier = await center("data.notifier");
  await glide(notifier, 150);
  await page.mouse.down();
  await sleep(80);
  await glide(await inside("services"), 700);
  await sleep(120);
  await page.mouse.up();
  await toast("Moved Notifier into Services");
  await sleep(700);

  const edge = await page.evaluate(() => window.editor.view.conns.find((c) => c.src === "services.orders" && c.dst === "data.cache").id);
  const end = await page.evaluate((e) => window.editor.endScreen(e, "dst"), edge);
  await glide(end, 150);
  await page.mouse.down();
  await sleep(80);
  const db = await center("data.db");
  await glide(db, 700);
  await sleep(120);
  await page.mouse.up();
  await toast("Connected to Postgres");
  await sleep(700);

  await sleep(900);
  await session.send("Page.stopScreencast");
  const finishedAt = frames.at(-1).at + 200;
  if (process.env["DEMO_FRAMES"]) {
    for (let i = 0; i < frames.length; i += 6)
      writeFileSync(path.join(process.env["DEMO_FRAMES"], `f${String(i).padStart(3, "0")}.jpg`), frames[i].jpeg);
  }

  const decode = (jpeg) =>
    decoder.evaluate(async (b64) => {
      const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let binary = "";
      for (let i = 0; i < pixels.length; i += 0x8000) binary += String.fromCharCode(...pixels.subarray(i, i + 0x8000));
      return btoa(binary);
    }, jpeg.toString("base64"));

  console.log("raw frames", frames.length, ((frames.at(-1).at - frames[0].at) / 1000).toFixed(1));
  const gif = GIFEncoder();
  let previous = null;
  let kept = 0;
  const queue = [];
  for (let i = 0; i < frames.length; i++) {
    const next = frames[i + 1]?.at ?? finishedAt;
    const delay = Math.max(10, next - frames[i].at);
    const raw = Buffer.from(await decode(frames[i].jpeg), "base64");
    if (previous && Buffer.compare(previous.raw, raw) === 0) {
      previous.delay += delay;
      continue;
    }
    if (previous && previous.delay < 40) {
      previous.delay += delay;
      previous.raw = raw;
      continue;
    }
    previous = { raw, delay };
    queue.push(previous);
  }
  const sample = Buffer.concat(queue.filter((_, i) => i % 8 === 0).map((f) => f.raw));
  const palette = quantize(new Uint8Array(sample), 255);
  palette.push([0, 0, 0]);
  let last = null;
  for (const frame of queue) {
    const indexed = applyPalette(new Uint8Array(frame.raw), palette);
    const delta = last ? indexed.map((value, i) => (value === last[i] ? 255 : value)) : indexed;
    gif.writeFrame(
      delta,
      WIDTH,
      HEIGHT,
      last ? { delay: frame.delay, transparent: true, transparentIndex: 255, dispose: 1 } : { palette, delay: frame.delay, dispose: 1 },
    );
    last = indexed;
    kept++;
  }
  gif.finish();
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, gif.bytes());
  const seconds = queue.reduce((sum, f) => sum + f.delay, 0) / 1000;
  console.log(`${out}: ${kept} frames, ${seconds.toFixed(1)}s, ${(gif.bytes().length / 1e6).toFixed(2)} MB`);
  await browser.close();
}

try {
  await main();
} finally {
  server.kill();
}
