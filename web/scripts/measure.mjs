import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const url = process.argv[2] ?? "http://127.0.0.1:8802/d2-squared/";
const large = resolve(import.meta.dirname, "..", "..", "engine", "testdata", "erd-large.d2");
const channel = process.env.PW_CHANNEL;
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });

async function run(label, prepare, drag) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const started = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => !!window.editor?.view?.scene && !document.getElementById("loading")?.offsetParent, null, {
    timeout: 120000,
  });
  const firstLoad = Date.now() - started;
  await prepare(page);
  await page.waitForTimeout(4000);
  const from = await page.evaluate(drag.from);
  const to = await page.evaluate(drag.to);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 20, from.y + ((to.y - from.y) * i) / 20);
    await page.waitForTimeout(12);
  }
  await page.waitForFunction(() => window.d2Stats?.current?.done, null, { timeout: 120000 });
  await page.mouse.up();
  await page.waitForFunction(() => !window.editor.busy, null, { timeout: 120000 });
  await page.waitForTimeout(300);
  const s = await page.evaluate(() => window.d2Stats.last);
  console.log(
    JSON.stringify({
      label,
      firstLoadMs: firstLoad,
      firstZoneMs: Math.round(s.firstZoneMs),
      allZonesMs: Math.round(s.allZonesMs),
      dropToViewMs: Math.round(s.dropToViewMs),
    }),
  );
  await page.close();
}

const noop = async () => {};
await run("architecture", noop, {
  from: () => window.editor.screenCenter("services.billing"),
  to: () => {
    const d = window.editor.shape("data");
    return window.editor.screenPoint(d.x + 40, d.y + 80);
  },
});
await run(
  "shop ERD (8 tables)",
  async (page) => {
    await page.selectOption("#example", "erd");
    await page.waitForTimeout(1500);
  },
  {
    from: () => {
      const c = window.editor.view.conns.find((x) => x.src === "reviews" && x.dst === "customers");
      return window.editor.endScreen(c.id, "dst");
    },
    to: () => window.editor.screenCenter("orders"),
  },
);
const source = readFileSync(large, "utf8");
await run(
  "large ERD (36 tables)",
  async (page) => {
    await page.click("#edit");
    await page.fill("#source-edit", source);
    const t = Date.now();
    await page.click("#apply");
    await page.waitForFunction(() => window.editor.view.shapes.length === 36, null, { timeout: 120000 });
    console.log(JSON.stringify({ label: "large ERD open", ms: Date.now() - t }));
    await page.evaluate(() => window.editor.setScale(0.2));
  },
  {
    from: () => {
      const c = window.editor.view.conns.find((x) => x.src === "reviews" && x.dst === "customers");
      return window.editor.endScreen(c.id, "dst");
    },
    to: () => window.editor.screenCenter("orders"),
  },
);
await browser.close();
