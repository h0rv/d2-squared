import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const url = process.argv[2] ?? "http://127.0.0.1:8806/d2-squared/";
const out = resolve(process.argv[3] ?? "test-results/ux-v2");
mkdirSync(out, { recursive: true });
const ready = () =>
  !!(window.editor?.view?.scene ?? window.editor?.view?.svg) &&
  !!document.body.dataset.ready &&
  !document.getElementById("loading")?.offsetParent;
const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) });
const devices = { desktop: { viewport: { width: 1440, height: 900 } }, phone: { viewport: { width: 390, height: 844 }, hasTouch: true } };
for (const scheme of ["light", "dark"]) {
  for (const [name, device] of Object.entries(devices)) {
    const page = await (await browser.newContext({ ...device, colorScheme: scheme, deviceScaleFactor: 2 })).newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(url);
    await page.waitForFunction(ready, null, { timeout: 60000 });
    await page.waitForTimeout(700);
    const shot = (kind) => page.screenshot({ path: resolve(out, `${scheme}-${name}-${kind}.png`) });
    await shot("idle");
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
    await shot("drag");
    await page.mouse.up();
    await page.waitForFunction(() => !window.editor.busy, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    await shot("drop");
    await page.click("#code-toggle");
    await page.waitForTimeout(900);
    await shot("code");
    console.log(scheme, name, errors);
    await page.context().close();
  }
}
await browser.close();
