import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const url = process.argv[2] ?? "http://127.0.0.1:8802/d2-squared/";
const out = resolve(import.meta.dirname, "..", "..", "docs");
const scheme = process.argv[3] ?? "light";
const name = process.argv[4] ?? "screenshot";
const example = process.argv[5] ?? "architecture";
mkdirSync(out, { recursive: true });

const channel = process.env.PW_CHANNEL;
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, colorScheme: scheme, deviceScaleFactor: 2 });
await page.goto(url);
await page.waitForFunction(() => !!window.editor?.view?.svg && !document.getElementById("loading")?.offsetParent, null, { timeout: 60000 });
if (example !== "architecture") {
  await page.selectOption("#example", example);
  await page.waitForTimeout(1500);
}
await page.waitForTimeout(400);
if (process.argv[6] === "first") {
  await page.screenshot({ path: resolve(out, `${name}.png`) });
  await browser.close();
  process.exit(0);
}
const from = await page.evaluate(() => window.editor.screenCenter("services.billing"));
const data = await page.evaluate(() => window.editor.shape("data"));
const to = await page.evaluate((d) => window.editor.screenPoint(d.x + 60, d.y + 90), data);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
for (let i = 1; i <= 24; i++) {
  await page.mouse.move(from.x + ((to.x - from.x) * i) / 24, from.y + ((to.y - from.y) * i) / 24);
  await page.waitForTimeout(12);
}
await page.waitForFunction(() => window.d2Stats?.current?.done, null, { timeout: 60000 });
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(out, `${name}.png`) });
await page.mouse.up();
await browser.close();
