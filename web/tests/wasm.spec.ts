import { writeFileSync, mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { Diagram, expectClean, sleep } from "./helpers";

const PAGE = "/d2-squared/";

test.afterEach(expectClean);

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
    await page.waitForFunction(() => !!window.editor?.view?.scene);
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
    await diagram.noErrors();
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

test("wasm: editing the source and sharing a link", async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
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
        const r = document.querySelector(".d2-cam")!.getBoundingClientRect();
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

const sample = (page: Page, shot: Buffer, x: number, y: number) =>
  page.evaluate(
    async ([b64, px, py]) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const [r = 0, g = 0, b = 0] = ctx.getImageData(Number(px), Number(py), 1, 1).data;
      return [r, g, b];
    },
    [shot.toString("base64"), x, y] as const,
  );

for (const scheme of ["light", "dark"] as const) {
  test(`wasm: a box dragged past the diagram edge is never clipped (${scheme})`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    const { diagram } = await open(page, "architecture");
    await page.evaluate(() => window.editor!.fit());
    await sleep(400);
    const left = await page.evaluate(() => {
      const e = window.editor!;
      return Math.min(...e.view!.shapes.map((s) => e.screenPoint(s.x, s.y).x));
    });
    const from = await diagram.center("clients.web");
    const to = { x: Math.max(left - 150, 60), y: Math.max(from.y - 200, 120) };
    expect(to.x).toBeLessThan(left - 40);
    await diagram.drag(from, to, { release: false, hold: false, steps: 30 });
    await sleep(400);
    const info = await page.evaluate(() => {
      const piece = document.querySelector<SVGGElement>('.l-drag [data-id="clients.web"]')!;
      const r = piece.getBoundingClientRect();
      const shape = piece.querySelector(".shape rect")!;
      const sr = shape.getBoundingClientRect();
      const arrows = [...document.querySelectorAll(".l-drag path.connection")].map((p) => {
        const b = p.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      });
      const clips: string[] = [];
      for (let n: Element | null = piece; n && n !== document.documentElement; n = n.parentElement) {
        const css = getComputedStyle(n);
        if (n.classList.contains("d2-stage") || n.classList.contains("d2-scene")) continue;
        if (css.clipPath !== "none" || /paint|strict|content/.test(css.contain) || (n.tagName !== "BODY" && css.overflow === "hidden"))
          clips.push(n.tagName + "." + n.getAttribute("class"));
      }
      return {
        box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
        shape: { x: sr.left + 8, y: sr.top + 8 },
        fill: getComputedStyle(shape).fill,
        paper: getComputedStyle(document.body).backgroundColor,
        arrows,
        clips,
        view: { w: innerWidth, h: innerHeight },
      };
    });
    expect(info.clips).toEqual([]);
    expect(info.box.left).toBeGreaterThanOrEqual(0);
    expect(info.box.top).toBeGreaterThanOrEqual(0);
    expect(info.box.right).toBeLessThanOrEqual(info.view.w);
    expect(info.box.bottom).toBeLessThanOrEqual(info.view.h);
    expect(info.box.left).toBeLessThan(left);
    expect(info.arrows.length).toBeGreaterThan(0);
    for (const a of info.arrows) {
      expect(a.right - a.left + (a.bottom - a.top)).toBeGreaterThan(20);
      expect(a.left).toBeGreaterThanOrEqual(0);
      expect(a.top).toBeGreaterThanOrEqual(0);
    }
    if (browser.browserType().name() !== "webkit") {
      const [r = 0, g = 0, b = 0] = await sample(page, await page.screenshot(), info.shape.x, info.shape.y);
      const fill = info.fill.match(/\d+/g)!.map(Number);
      const paper = info.paper.match(/\d+/g)!.map(Number);
      const want = fill.map((c, i) => c * 0.85 + paper[i]! * 0.15);
      expect(Math.abs(r - want[0]!) + Math.abs(g - want[1]!) + Math.abs(b - want[2]!)).toBeLessThan(24);
    }
    await page.screenshot({ path: `test-results/ux-v2/${scheme}-desktop-drag-past-edge.png` });
    await diagram.cancelDrag();
    await context.close();
  });
}

test("wasm: dragging far right and down keeps the whole diagram visible after the refit", async ({ page }) => {
  const { diagram } = await open(page, "architecture");
  await page.evaluate(() => window.editor!.fit());
  await sleep(400);
  const from = await diagram.center("gateway");
  await diagram.drag(from, { x: 1380, y: 800 }, { hold: false, steps: 30 });
  await sleep(1200);
  expect(await page.evaluate(() => window.editor!.fitted)).toBe(true);
  const box = await page.evaluate(() => {
    const r = document.querySelector(".d2-cam")!.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: innerWidth, h: innerHeight };
  });
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(box.w);
  expect(box.bottom).toBeLessThanOrEqual(box.h);
  await page.screenshot({ path: "test-results/ux-v2/light-desktop-drop-far.png" });
});

async function corner(page: Page, id: string, which: "se" | "nw") {
  return page.evaluate(
    ([i, w]) => {
      const e = window.editor!;
      const s = e.shape(i!)!;
      return w === "se" ? e.screenPoint(s.x + s.width, s.y + s.height) : e.screenPoint(s.x, s.y);
    },
    [id, which] as const,
  );
}

test("wasm: resize a box and a group by their corner handles", async ({ page }) => {
  const { diagram } = await open(page, "architecture");
  await page.evaluate(() => window.editor!.fit());
  await sleep(400);
  const before = await diagram.source();
  const c = await diagram.center("gateway");
  await page.mouse.click(c.x, c.y);
  await expect(page.locator(".l-sel .handle")).toHaveCount(4);
  await page.screenshot({ path: "test-results/ux-v2/light-desktop-handles.png" });
  const start = await diagram.mustShape("gateway");
  const scale = await page.evaluate(() => window.editor!.scale);
  const se = await corner(page, "gateway", "se");
  await diagram.drag(se, { x: se.x + 60, y: se.y + 36 }, { hold: false });
  const grown = await diagram.mustShape("gateway");
  expect(Math.abs(grown.width - (start.width + 60 / scale))).toBeLessThan(3);
  expect(Math.abs(grown.height - (start.height + 36 / scale))).toBeLessThan(3);
  expect(grown.x).toBe(start.x);
  expect(await diagram.source()).toMatch(new RegExp(`width: ${grown.width}\\b`));
  await expect(page.locator("#toast")).toContainText("Resized API gateway");
  await expect(page.locator("#toast")).toContainText("Undo");
  await page.locator("#toast .toast-action").click();
  await diagram.idle();
  await sleep(500);
  expect(await diagram.source()).toBe(before);

  const group = await diagram.mustShape("services");
  const inside = await diagram.at(group.x + 12, group.y + 12);
  await page.mouse.click(inside.x, inside.y);
  await expect(page.locator(".d2-action")).toBeVisible();
  const gse = await corner(page, "services", "se");
  await diagram.drag(gse, { x: gse.x + 70, y: gse.y + 50 }, { hold: false });
  const wide = await diagram.mustShape("services");
  expect(wide.width).toBeGreaterThan(group.width + 60 / scale - 4);
  expect(await diagram.source()).toMatch(/services: Services \{[\s\S]*?width: \d+/);
  await page.screenshot({ path: "test-results/ux-v2/light-desktop-resized.png" });
});

test("wasm: tidy up a group drops its saved positions and keeps the rest", async ({ page }) => {
  const { diagram } = await open(page, "architecture");
  await page.evaluate(() => window.editor!.fit());
  await sleep(400);
  const notifier = await diagram.mustShape("services.notifier");
  const group = await diagram.mustShape("services");
  const from = await diagram.center("services.notifier");
  const to = await diagram.at(group.x + group.width / 2, group.y + 40);
  await diagram.drag(from, to, { hold: false });
  expect((await diagram.mustShape("services.notifier")).x).not.toBe(notifier.x);
  const pinnedFile = await diagram.source();
  expect(pinnedFile).toMatch(/notifier: Notifier \{[^}]*left:/);
  const gateway = await diagram.mustShape("gateway");
  const inside = await diagram.at(group.x + 14, group.y + 14);
  await page.mouse.click(inside.x, inside.y);
  const tidy = page.locator(".d2-action");
  await expect(tidy).toBeVisible();
  await expect(tidy).toHaveText("Tidy up");
  await page.screenshot({ path: "test-results/ux-v2/light-desktop-tidy-action.png" });
  await tidy.click();
  await expect(page.locator("#toast")).toContainText("Tidied up Services");
  await diagram.idle();
  await sleep(700);
  const tidied = await diagram.source();
  expect(tidied).not.toMatch(/notifier: Notifier \{[^}]*left:/);
  expect(tidied).toMatch(/gateway: API gateway \{[^}]*left:/);
  const after = await diagram.mustShape("gateway");
  expect([after.x, after.y]).toEqual([gateway.x, gateway.y]);
  await page.click("#more");
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "test-results/ux-v2/light-desktop-tidied.png" });
});
