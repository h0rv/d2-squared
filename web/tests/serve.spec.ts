import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test as base } from "@playwright/test";
import { Diagram, expectClean, frameStats, sleep } from "./helpers";

const engineDir = path.resolve(import.meta.dirname, "../../engine");
const binary = path.resolve(import.meta.dirname, "../.build/d2squared");
const PORT = 8808;

interface Served {
  file: string;
  url: string;
  source(): string;
}

const test = base.extend<{ serve: (fixture: string) => Promise<Served> }>({
  serve: async ({ browserName: _browserName }, use) => {
    const children: ChildProcess[] = [];
    await use(async (fixture) => {
      const dir = mkdtempSync(path.join(tmpdir(), "d2squared-"));
      const file = path.join(dir, "diagram.d2");
      copyFileSync(path.join(engineDir, "testdata", fixture), file);
      const child = spawn(binary, ["serve", "-addr", `127.0.0.1:${PORT}`, file], { stdio: "ignore" });
      children.push(child);
      for (let i = 0; i < 150; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${PORT}/api/info`);
          if (res.ok) break;
        } catch {
          await sleep(200);
        }
      }
      return {
        file,
        url: `http://127.0.0.1:${PORT}/`,
        source: () => readFileSync(file, "utf8"),
      };
    });
    for (const child of children) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  },
});

test.afterEach(expectClean);

test.beforeAll(() => {
  mkdirSync(path.dirname(binary), { recursive: true });
  execFileSync("go", ["build", "-o", binary, "./cmd/d2squared"], {
    cwd: engineDir,
    stdio: "inherit",
  });
});

async function open(page: import("@playwright/test").Page, url: string): Promise<Diagram> {
  await page.goto(url);
  const diagram = new Diagram(page);
  await diagram.ready(30_000);
  await sleep(300);
  return diagram;
}

test("serve: architecture drags, undo and agent edits", async ({ page, serve }) => {
  const served = await serve("arch.d2");
  const d = await open(page, served.url);
  await d.setScale(0.55);
  await sleep(200);

  await d.openCode();
  const data = await d.mustShape("data");
  let live: {
    paths: string[];
    labels: (string | null)[];
    copies: number;
  } | null = null;
  let r = await d.drag(await d.center("services.billing"), await d.at(data.x + 40, data.y + 80), {
    afterZones: async () => {
      live = await page.evaluate(() => ({
        paths: [...document.querySelectorAll(".l-drag path.connection")].map((p) => p.getAttribute("d") ?? ""),
        labels: [...document.querySelectorAll(".l-drag .label text")].map((n) => n.textContent),
        copies: [...document.querySelectorAll(".d2-cam text")].filter((n) => n.textContent === "events").length,
      }));
    },
  });
  expect(live!.paths.some((p) => / S /.test(p))).toBe(true);
  expect(live!.labels).toContain("events");
  expect(live!.copies).toBe(1);
  expect(r.dashed).toBe(0);
  expect(r.status).toMatch(/^Move into data$/i);
  expect(r.diff).toMatch(/\+/);
  expect(await page.locator("#filename").textContent()).toContain("diagram.d2");
  await expect(page.locator("#examples")).toBeHidden();
  await page.click("#more");
  await expect(page.locator("#open")).toBeHidden();
  await expect(page.locator("#reset")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(served.source()).toMatch(/^data: \{[\s\S]*?billing: Billing Service[\s\S]*?^\}/m);
  expect(await d.shape("data.billing")).not.toBeNull();

  const idp = await d.mustShape("idp");
  await d.drag(await d.center("idp"), await d.at(idp.x + idp.width / 2 + 220, idp.y + idp.height / 2 - 120), { hold: false });
  const idp2 = await d.mustShape("idp");
  expect(Math.abs(idp2.x - (idp.x + 220))).toBeLessThan(6);
  expect(Math.abs(idp2.y - (idp.y - 120))).toBeLessThan(6);

  const eid = await page.evaluate(() => window.editor!.view!.conns.find((c) => c.src === "edge.mobile")!.id);
  r = await d.drag(await d.end(eid, "dst"), await d.center("services.users"));
  expect(r.status).toBe("Connect to User Service");
  await expect(page.locator("#toast")).toContainText("Connected to User Service");
  expect(served.source()).toMatch(/edge\.mobile -> services\.users/);

  const before = served.source();
  const auth = await d.center("services.auth");
  await d.drag(auth, { x: auth.x + 300, y: auth.y + 200 }, { release: false, hold: false });
  await d.cancelDrag();
  expect(served.source()).toBe(before);
  expect(await page.evaluate(() => document.querySelectorAll(".d2-cam [data-id][transform]").length)).toBe(0);

  await page.keyboard.press("Control+z");
  await sleep(600);
  expect(served.source()).not.toMatch(/edge\.mobile -> services\.users/);
  await page.keyboard.press("Control+Shift+z");
  await sleep(600);
  expect(served.source()).toMatch(/edge\.mobile -> services\.users/);

  const known = await d.allShapes();
  appendFileSync(
    served.file,
    "\ndata.audit: Audit Log {shape: cylinder}\ndata.metrics: Metrics {shape: cylinder}\nservices.core.reports: Reports\nservices.core.reports -> data.metrics\nservices.core.orders -> data.audit\n",
  );
  await sleep(2000);
  const now = await d.allShapes();
  expect(now["data.audit"]).toBeDefined();
  expect(now["services.core.reports"]).toBeDefined();
  const moved = Object.keys(known).filter(
    (k) => now[k] && (Math.abs(now[k][0] - known[k]![0]) > 1 || Math.abs(now[k][1] - known[k]![1]) > 1),
  );
  expect(moved).toEqual([]);

  const pg = await d.mustShape("data.pg");
  await d.drag(await d.center("data.pg"), await d.at(pg.x + pg.width / 2 + 40, pg.y + pg.height / 2 + 30), { hold: false });
  const pg2 = await d.mustShape("data.pg");
  expect(Math.abs(pg2.x - pg.x - 40)).toBeLessThan(6);
  expect(Math.abs(pg2.y - pg.y - 30)).toBeLessThan(6);
  await page.screenshot({ path: "test-results/serve-architecture.png" });
  await d.noErrors();
});

test("serve: large ERD pin, column reconnect, early drop and autoscroll", async ({ page, serve }) => {
  const served = await serve("erd-large.d2");
  const d = await open(page, served.url);
  await d.setScale(0.35);
  await sleep(300);
  const orders = await d.mustShape("orders");
  const from = await d.center("orders");
  const dx = from.x > 700 ? -160 : 160;
  const dy = from.y > 450 ? -90 : 90;
  const r = await d.drag(from, { x: from.x + dx, y: from.y + dy });
  const after = await d.mustShape("orders");
  expect(Math.abs(after.x - orders.x - dx / 0.35)).toBeLessThan(8);
  expect(Math.abs(after.y - orders.y - dy / 0.35)).toBeLessThan(8);
  expect(frameStats(r.frames).p95).toBeLessThan(40);

  await d.setScale(0.2);
  await sleep(300);
  const eid = await d.edgeId("order_items", "orders");
  const customers = await d.mustShape("customers");
  const cols = customers.cols ?? [];
  const row = Math.floor(cols.length / 2);
  const rh = customers.height / (cols.length + 1);
  const drop = await d.at(customers.x + customers.width / 2, customers.y + rh * (row + 1.5));
  const rc = await d.drag(await d.end(eid, "dst"), drop);
  expect(rc.dashed).toBe(0);
  expect(rc.status).toMatch(/^Connect to /);
  expect(served.source()).toMatch(new RegExp(`-> customers\\.${cols[row]}\\b`));

  const eid2 = await d.edgeId("payments", "orders");
  const warehouses = await d.mustShape("invoices");
  const before = served.source();
  await d.drag(await d.end(eid2, "dst"), await d.at(warehouses.x + warehouses.width / 2, warehouses.y + warehouses.height / 2), {
    steps: 6,
    hold: false,
  });
  await sleep(1500);
  expect(served.source()).not.toBe(before);
  expect(served.source()).toMatch(/payments\.order_id -> invoices\./);

  await d.setScale(0.35);
  await sleep(300);
  const team = await d.center("products");
  const stageRect = await page.evaluate(() => ({
    right: window.innerWidth,
    bottom: window.innerHeight,
  }));
  const canvasAt = async () => {
    const p = await d.at(0, 0);
    return [p.x, p.y] as const;
  };
  const startScroll = await canvasAt();
  await d.drag(team, { x: stageRect.right - 12, y: stageRect.bottom - 12 }, { release: false, hold: false });
  await sleep(700);
  const scrolled = await canvasAt();
  await d.cancelDrag();
  expect(startScroll[0] - scrolled[0] > 50 || startScroll[1] - scrolled[1] > 50).toBe(true);
  await d.noErrors();
});

for (const scheme of ["dark", "light"] as const) {
  test(`serve: colors and layer order after drops (${scheme})`, async ({ browser, serve }) => {
    const served = await serve("arch.d2");
    const context = await browser.newContext({
      colorScheme: scheme,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const d = await open(page, served.url);
    for (const dx of [-280, 200]) {
      const box = await page.evaluate(() => {
        const s = window.editor!.shape("edge")!;
        return window.editor!.screenPoint(s.x + 30 / window.editor!.scale, s.y + 12 / window.editor!.scale);
      });
      await d.drag(box, { x: box.x + dx, y: box.y }, { hold: false, steps: 20 });
      appendFileSync(served.file, "\n");
      await sleep(2500);
      const state = await d.colorsAndOrder();
      expect(state.fill).not.toBe("rgb(0, 0, 0)");
      expect(state).toMatchObject({ sameOrder: true, hidden: 0, leftovers: 0 });
    }
    await page.screenshot({ path: `test-results/serve-${scheme}.png` });
    await d.noErrors();
    await context.close();
  });
}

test("serve: ELK is saved to the file and the exports download", async ({ page, serve }) => {
  const served = await serve("arch.d2");
  const d = await open(page, served.url);
  await page.click("#more");
  await page.click('[data-engine="elk"]');
  await page.waitForFunction(() => window.editor!.view!.config.engine === "elk", null, { timeout: 60_000 });
  await d.idle();
  expect(served.source()).toMatch(/layout-engine: elk/);
  await page.click("#view-text");
  await expect(page.locator("#text-out")).toContainText("Postgres");
  await page.click("#view-diagram");
  for (const [kind, name] of [
    ["svg", "diagram.svg"],
    ["png", "diagram.png"],
    ["text", "diagram.txt"],
  ] as const) {
    await page.click("#more");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click(`[data-export="${kind}"]`)]);
    expect(download.suggestedFilename()).toBe(name);
    expect(readFileSync((await download.path())!).length).toBeGreaterThan(100);
  }
});

const centerGap = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const out = document.getElementById("text-out")!.getBoundingClientRect();
    const box = document.getElementById("text-scroll")!.getBoundingClientRect();
    return {
      x: out.left + out.width / 2 - (box.left + box.width / 2),
      y: out.top + out.height / 2 - (box.top + box.height / 2),
    };
  });

test("serve: the text view shows the diagram, centers it and copies it", async ({ page, context, browserName, serve }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const served = await serve("sized.d2");
  const d = await open(page, served.url);
  await page.click("#view-text");
  const out = page.locator("#text-out");
  await expect(out).toContainText("Alpha");
  await expect(out).toContainText("Gamma");
  const gap = await centerGap(page);
  expect(Math.abs(gap.x)).toBeLessThan(4);
  expect(Math.abs(gap.y)).toBeLessThan(4);
  await page.click("#text-copy");
  await expect(page.locator("#toast")).toContainText("Copied");
  if (browserName === "chromium") expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Alpha");
  await d.noErrors();
});

const textSizes = {
  desktop: { width: 1500, height: 950 },
  phone: { width: 390, height: 780 },
};

for (const fixture of ["sized.d2", "arch.d2"]) {
  test(`serve: text view screenshots (${fixture})`, async ({ browser, serve }) => {
    mkdirSync("test-results/ux-v6", { recursive: true });
    const served = await serve(fixture);
    const name = fixture.replace(".d2", "");
    for (const scheme of ["light", "dark"] as const) {
      for (const [size, viewport] of Object.entries(textSizes)) {
        const context = await browser.newContext({
          colorScheme: scheme,
          viewport,
        });
        const page = await context.newPage();
        await open(page, served.url);
        await page.click("#view-text");
        await expect(page.locator("#text-out")).toContainText(fixture === "sized.d2" ? "Alpha" : "Postgres");
        for (const charset of ["unicode", "ascii"]) {
          await page.click(`#text-${charset}`);
          await sleep(500);
          await page.screenshot({
            path: `test-results/ux-v6/${name}-${scheme}-${size}-${charset}.png`,
          });
        }
        await context.close();
      }
    }
  });
}
