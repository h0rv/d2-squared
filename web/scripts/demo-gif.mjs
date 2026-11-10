import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
      "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(20,24,36,.45);border:2px solid #fff;box-shadow:0 0 0 1px rgba(20,24,36,.6);pointer-events:none;z-index:2147483647;display:none";
    document.body.append(dot);
    addEventListener(
      "pointermove",
      (e) => {
        dot.style.display = "block";
        dot.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;
      },
      true,
    );
  });
};

async function main() {
  await waitForServer();
  const browser = await chromium.launch({ channel: process.env["PW_CHANNEL"] || undefined });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: "light", deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem("d2sq.hint", "1"));
  await context.addInitScript(cursor);
  const page = await context.newPage();
  const decoder = await context.newPage();
  await page.goto(URL);
  await page.waitForFunction(
    () => !!window.editor?.view?.scene && !!document.body.dataset["ready"] && !document.getElementById("loading")?.offsetParent,
  );
  await page.evaluate(() => window.editor.fit());
  await sleep(800);

  const frames = [];
  const session = await context.newCDPSession(page);
  session.on("Page.screencastFrame", (frame) => {
    frames.push({ at: frame.metadata.timestamp * 1000, jpeg: Buffer.from(frame.data, "base64") });
    void session.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });

  const center = (id) => page.evaluate((i) => window.editor.screenCenter(i), id);
  const glide = async (from, to, steps, pause) => {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t * t * (3 - 2 * t);
      await page.mouse.move(from.x + (to.x - from.x) * ease, from.y + (to.y - from.y) * ease);
      await sleep(pause);
    }
  };

  const billing = await center("services.billing");
  const data = await center("data");
  await page.mouse.move(billing.x + 60, billing.y + 90);
  await sleep(300);
  await glide({ x: billing.x + 60, y: billing.y + 90 }, billing, 6, 10);
  await page.mouse.down();
  await sleep(250);
  await glide(billing, { x: data.x, y: data.y - 20 }, 80, 16);
  await sleep(1100);
  await page.mouse.up();
  await page.waitForFunction(() => !window.editor.busy);
  await page.waitForFunction(() => document.getElementById("toast")?.textContent?.includes("Moved Billing into Data"));
  await sleep(1300);

  const edge = await page.evaluate(() => window.editor.view.conns.find((c) => c.src === "gateway" && c.dst === "services.auth").id);
  const end = await page.evaluate((e) => window.editor.endScreen(e, "dst"), edge);
  const target = await center("services.orders");
  await glide(await page.evaluate(() => ({ x: innerWidth / 2, y: innerHeight - 140 })), end, 8, 10);
  await page.mouse.down();
  await sleep(150);
  await glide(end, { x: target.x, y: target.y }, 45, 16);
  await sleep(800);
  await page.mouse.up();
  await page.waitForFunction(() => !window.editor.busy);
  await page.waitForFunction(() => document.getElementById("toast")?.textContent?.includes("Connected to"));
  await sleep(1300);

  await sleep(200);
  await session.send("Page.stopScreencast");
  const finishedAt = frames.at(-1).at + 200;

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
    if (previous && previous.delay < 66) {
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
