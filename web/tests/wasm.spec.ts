import { writeFileSync, mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { Diagram, sleep } from "./helpers";

const PAGE = "/d2-squared/";

const timings: Record<string, Record<string, number | null>> = {};

test.afterAll(() => {
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/wasm-timings.json", JSON.stringify(timings, null, 2));
});

async function open(page: Page, example: string, query = ""): Promise<{ diagram: Diagram; loadMs: number }> {
  const started = Date.now();
  await page.goto(PAGE + query);
  const diagram = new Diagram(page);
  await diagram.ready();
  if (example !== "architecture") {
    await page.click(`[data-example="${example}"]`);
    await page.waitForFunction((id) => document.querySelector(`[data-example="${id}"]`)?.getAttribute("aria-checked") === "true", example);
    await page.waitForFunction(() => !!window.editor?.view?.svg);
    await sleep(800);
  }
  const loadMs = Date.now() - started;
  await diagram.setScale(0.6);
  await sleep(200);
  return { diagram, loadMs };
}

interface Signature {
  example: string;
  run: (d: Diagram) => Promise<void>;
  check: (src: string) => void;
}

const signatures: Signature[] = [
  {
    example: "architecture",
    run: async (d) => {
      const data = await d.mustShape("data");
      await d.drag(await d.center("services.billing"), await d.at(data.x + 40, data.y + 80));
    },
    check: (src) => expect(src).toMatch(/^data: Data \{[\s\S]*?^ {2}billing: Billing/m),
  },
  {
    example: "erd",
    run: async (d) => {
      const edge = await d.edgeId("reviews", "customers");
      const orders = await d.mustShape("orders");
      await d.drag(await d.end(edge, "dst"), await d.at(orders.x + orders.width / 2, orders.y + orders.height / 2));
    },
    check: (src) => expect(src).toMatch(/reviews\.customer_id -> orders\./),
  },
  {
    example: "org",
    run: async (d) => {
      const edge = await d.edgeId("eng1", "dev2");
      await d.drag(await d.end(edge, "src"), await d.center("eng2"));
    },
    check: (src) => expect(src).toMatch(/eng2 -> dev2/),
  },
  {
    example: "states",
    run: async (d) => {
      const edge = await d.edgeId("placed", "cancelled");
      await d.drag(await d.end(edge, "dst"), await d.center("refunded"));
    },
    check: (src) => expect(src).toMatch(/placed -> refunded: cancel/),
  },
  {
    example: "family",
    run: async (d) => {
      const cora = await d.mustShape("rose.cora");
      await d.drag(await d.center("rose.ben.max"), await d.at(cora.x + 40, cora.y + 60));
    },
    check: (src) => expect(src).toMatch(/cora: Cora \{[\s\S]*?max: Max[\s\S]*?\}/),
  },
];

for (const sig of signatures) {
  test(`wasm: ${sig.example} signature drag`, async ({ page }) => {
    const { diagram, loadMs } = await open(page, sig.example);
    const before = await diagram.source();
    await sig.run(diagram);
    const after = await diagram.source();
    expect(after).not.toBe(before);
    sig.check(after);
    const state = await diagram.colorsAndOrder();
    expect(state.fill).not.toBe("rgb(0, 0, 0)");
    expect(state.sameOrder).toBe(true);
    expect(state.hidden).toBe(0);
    expect(state.leftovers).toBe(0);
    const stats = await page.evaluate(() => window.d2Stats?.last ?? null);
    timings[sig.example] = {
      loadMs,
      firstZoneMs: stats?.firstZoneMs ?? null,
      allZonesMs: stats?.allZonesMs ?? null,
      dropToViewMs: stats?.dropToViewMs ?? null,
    };
    await page.screenshot({ path: `test-results/wasm-${sig.example}.png` });
    diagram.noErrors();
  });
}

test("wasm: dark mode keeps fills and undo restores the file", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "dark", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const { diagram } = await open(page, "architecture");
  const before = await diagram.source();
  const data = await diagram.mustShape("data");
  await diagram.drag(await diagram.center("services.billing"), await diagram.at(data.x + 40, data.y + 80));
  expect((await diagram.colorsAndOrder()).fill).not.toBe("rgb(0, 0, 0)");
  await page.screenshot({ path: "test-results/wasm-dark.png" });
  await page.keyboard.press("Control+z");
  await diagram.idle();
  await sleep(500);
  expect(await diagram.source()).toBe(before);
  await context.close();
});

test("wasm: editing the source and sharing a link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, "architecture");
  await page.click("#code-toggle");
  await page.fill("#code-input", "a: Alpha\nb: Beta\na -> b\n");
  await page.waitForFunction(() => window.editor?.view?.shapes.length === 2);
  await page.click("#more");
  await page.click("#share");
  await expect(page.locator("#toast")).toContainText("Link copied");
  await sleep(500);
  const url = page.url();
  expect(url).toContain("#s=");
  const second = await context.newPage();
  await second.goto(url);
  const other = new Diagram(second);
  await other.ready();
  expect(await other.source()).toContain("a -> b");
});

test("wasm: helper workers lay out zones in parallel", async ({ page }) => {
  const { diagram } = await open(page, "architecture", "?workers=3");
  await page.waitForTimeout(4000);
  const edges = await diagram.edgeId("services.orders", "data.db");
  const end = await diagram.end(edges, "dst");
  const target = await diagram.center("data.cache");
  const result = await diagram.drag(end, target);
  expect(result.status).toBeTruthy();
  expect(await diagram.source()).toMatch(/services\.orders -> data\.cache/);
});

test("wasm: the code panel is hidden at first and toggles", async ({ page }) => {
  await open(page, "architecture");
  await expect(page.locator("#code")).toBeHidden();
  await page.click("#code-toggle");
  await expect(page.locator("#code")).toBeVisible();
  await expect(page.locator("#code-lines .ln").first()).toBeVisible();
  await page.click("#code-close");
  await expect(page.locator("#code")).toBeHidden();
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`wasm: the whole diagram is visible at ${size.width}x${size.height}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: size, hasTouch: size.width < 700 });
    const page = await context.newPage();
    const diagram = new Diagram(page);
    await page.goto(PAGE);
    await diagram.ready();
    await sleep(500);
    const inside = async (height = size.height) => {
      const box = await page.evaluate(() => {
        const r = document.querySelector(".d2-svg > svg")!.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(size.width);
      expect(box.bottom).toBeLessThanOrEqual(height);
    };
    await inside();
    await page.setViewportSize({ width: size.width, height: size.height - 120 });
    await sleep(400);
    await inside(size.height - 120);
    await context.close();
  });
}

test("wasm: the hint fades after the first drag and stays hidden", async ({ page }) => {
  const { diagram } = await open(page, "architecture");
  await expect(page.locator("#hint")).toBeVisible();
  const data = await diagram.mustShape("data");
  await diagram.drag(await diagram.center("services.billing"), await diagram.at(data.x + 40, data.y + 80));
  await expect(page.locator("#hint")).toBeHidden();
  await page.reload();
  await diagram.ready();
  await expect(page.locator("#hint")).toBeHidden();
});

test("wasm: a toast follows a drop and nothing dashed shows during the drag", async ({ page }) => {
  const { diagram } = await open(page, "architecture");
  await diagram.openCode();
  const data = await diagram.mustShape("data");
  const result = await diagram.drag(await diagram.center("services.billing"), await diagram.at(data.x + 40, data.y + 80));
  expect(result.status).toBe("Move into Data");
  expect(result.dashed).toBe(0);
  expect(result.highlighted).toBeGreaterThanOrEqual(1);
  expect(result.diff).toMatch(/\+/);
  await expect(page.locator("#toast")).toContainText("Moved Billing into Data");
  await expect(page.locator("#toast")).toContainText("Undo");
  await expect(page.locator("#code-lines .ln.hl").first()).toBeAttached();
  await expect(page.locator("#code-lines .ln.pos").first()).toBeVisible();
  await expect(page.locator("#toast")).toBeHidden({ timeout: 8000 });
});
