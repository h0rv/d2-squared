import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const url = process.argv[2] ?? "http://127.0.0.1:8806/d2-squared/";
const out = resolve(process.argv[3] ?? "test-results/ux-v3");
mkdirSync(out, { recursive: true });
const ready = () => !!window.editor?.view?.scene && !!document.body.dataset.ready && !document.getElementById("loading")?.offsetParent;
const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) });

async function open(scheme, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  await page.waitForFunction(ready, null, { timeout: 90000 });
  await page.waitForTimeout(600);
  return { page, context, errors };
}

const idle = (page) => page.waitForFunction(() => !window.editor.busy, null, { timeout: 90000 });

async function setEngine(page, engine) {
  await page.evaluate((to) => window.editor.send({ kind: "config", key: "layout-engine", to }), engine);
  await page.waitForFunction((e) => window.editor.view.config.engine === e, engine, { timeout: 90000 });
  await idle(page);
  await page.waitForTimeout(900);
}

async function drag(page, from, to, release) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 24, from.y + ((to.y - from.y) * i) / 24);
    await page.waitForTimeout(12);
  }
  await page.waitForFunction(() => window.d2Stats?.current?.done, null, { timeout: 90000 });
  await page.waitForTimeout(400);
  if (release) return;
}

const timings = {};
{
  const { page, context, errors } = await open("light");
  for (const engine of ["tala", "elk", "dagre"]) {
    const started = Date.now();
    await setEngine(page, engine);
    const switchMs = Date.now() - started;
    await page.screenshot({ path: resolve(out, `${engine}-architecture.png`) });
    const from = await page.evaluate(() => window.editor.screenCenter("services.billing"));
    const data = await page.evaluate(() => window.editor.shape("data"));
    const to = await page.evaluate((d) => window.editor.screenPoint(d.x + 60, d.y + 90), data);
    await drag(page, from, to);
    await page.screenshot({ path: resolve(out, `${engine}-drag.png`) });
    await page.mouse.up();
    await idle(page);
    await page.waitForTimeout(900);
    const stats = await page.evaluate(() => window.d2Stats.last);
    timings[engine] = {
      switchMs,
      firstZoneMs: Math.round(stats.firstZoneMs),
      allZonesMs: Math.round(stats.allZonesMs),
      dropToViewMs: Math.round(stats.dropToViewMs),
      source: (await page.evaluate(() => window.editor.view.source)).includes("data: Data {") ? "ok" : "",
    };
    await page.evaluate(() => window.editor.undo());
    await idle(page);
    await page.waitForTimeout(700);
  }
  await setEngine(page, "dagre");
  const id = (await page.evaluate(() => window.editor.shape("idp"))) ? "idp" : "gateway";
  const here = await page.evaluate((i) => window.editor.screenCenter(i), id);
  await drag(page, here, { x: here.x + 90, y: here.y + 140 }, false);
  await page.screenshot({ path: resolve(out, "dagre-place-blocked.png") });
  await page.mouse.up();
  await idle(page);
  console.log("errors", errors);
  await context.close();
}
console.log(JSON.stringify(timings, null, 1));

for (const scheme of ["light", "dark"]) {
  const { page, context, errors } = await open(scheme);
  await page.click("#view-text");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: resolve(out, `text-${scheme}.png`) });
  await page.click("#text-ascii");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: resolve(out, `text-${scheme}-ascii.png`) });
  await page.click("#view-diagram");
  await page.waitForTimeout(500);
  await page.click("#more");
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, `menu-${scheme}.png`) });
  await page.click("#sketch");
  await idle(page);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: resolve(out, `sketch-${scheme}.png`) });
  console.log(scheme, errors);
  await context.close();
}

{
  const { page, context, errors } = await open("light", { width: 390, height: 844 });
  await page.screenshot({ path: resolve(out, "phone-diagram.png") });
  await page.click("#view-text");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: resolve(out, "phone-text.png") });
  await page.click("#more");
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, "phone-menu.png") });
  console.log("phone", errors);
  await context.close();
}
await browser.close();
