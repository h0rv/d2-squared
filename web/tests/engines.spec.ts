import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { Diagram, expectClean, sleep } from "./helpers";

test.afterEach(expectClean);

async function open(page: Page): Promise<Diagram> {
  await page.goto("/d2-squared/");
  const diagram = new Diagram(page);
  await diagram.ready();
  await diagram.setScale(0.6);
  await sleep(200);
  return diagram;
}

async function menu(page: Page, selector: string): Promise<void> {
  await page.click("#more");
  await page.click(selector);
}

async function chooseEngine(page: Page, diagram: Diagram, engine: string): Promise<void> {
  await menu(page, `[data-engine="${engine}"]`);
  await page.waitForFunction((e) => window.editor!.view!.config.engine === e, engine, { timeout: 60_000 });
  await diagram.idle();
  await sleep(500);
}

const pins = (source: string): number => source.split("left:").length - 1;

test("engines: ELK writes the setting, moves a box into a group and can be undone", async ({ page }) => {
  const d = await open(page);
  await chooseEngine(page, d, "elk");
  await expect(page.locator("#toast")).toContainText("Layout engine: ELK");
  expect(await d.source()).toMatch(/layout-engine: elk/);
  await expect(page.locator('[data-engine="elk"]')).toHaveAttribute("aria-checked", "true");
  const before = pins(await d.source());
  const data = await d.mustShape("data");
  await d.drag(await d.center("services.billing"), await d.at(data.x + 40, data.y + 80));
  const source = await d.source();
  expect(source).toMatch(/^data: Data \{[\s\S]*?^ {2}billing: Billing/m);
  expect(pins(source)).toBe(before);
  await page.evaluate(() => window.editor!.undo());
  await d.idle();
  await page.evaluate(() => window.editor!.undo());
  await d.idle();
  await sleep(400);
  expect(await d.source()).toMatch(/layout-engine: tala/);
});

test("engines: with dagre, placing and resizing are off and say why", async ({ page }) => {
  const d = await open(page);
  await chooseEngine(page, d, "dagre");
  await expect(page.locator("#hint")).toContainText("Placing and resizing need the TALA layout engine");
  const before = await d.source();
  const gateway = await d.center("gateway");
  const result = await d.drag(gateway, { x: gateway.x + 40, y: gateway.y + 220 }, { hold: false, release: false });
  expect(result.status).toBe("Placing and resizing need the TALA layout engine");
  await page.mouse.up();
  await d.idle();
  await sleep(400);
  expect(await d.source()).toBe(before);
  await page.mouse.click(gateway.x, gateway.y);
  await expect(page.locator(".l-sel .sel-box")).toHaveCount(1);
  await expect(page.locator(".l-sel .handle")).toHaveCount(0);
  const group = await d.mustShape("services");
  const billing = await d.center("services.billing");
  const dropTo = await d.at(group.x + group.width / 2, group.y + group.height / 2);
  const move = await d.drag(billing, await d.at(dropTo.x, dropTo.y + 300), { hold: false, release: false });
  expect(move.status).toContain("top level");
  await page.mouse.up();
});

async function openText(page: Page): Promise<void> {
  await page.click("#more");
  await page.click("#text-export");
  await expect(page.locator("#text-modal")).toBeVisible();
}

test("engines: the text modal shows the diagram, switches characters, copies, downloads and follows edits", async ({
  page,
  context,
  browserName,
}) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const d = await open(page);
  await expect(page.locator("#view-text")).toHaveCount(0);
  await openText(page);
  const out = page.locator("#text-out");
  await expect(out).toContainText("Postgres");
  await expect(out).toContainText("┌");
  const box = await page.locator("#text-view").boundingBox();
  expect(box!.width).toBeGreaterThan(800);
  expect(box!.width).toBeLessThan(1500);
  await page.click('[data-charset="ascii"]');
  await expect(out).not.toContainText("┌");
  await expect(out).toContainText("Postgres");
  await page.click('[data-charset="unicode"]');
  await expect(out).toContainText("┌");
  await page.click("#text-copy");
  await expect(page.locator("#toast")).toContainText("Copied");
  if (browserName === "chromium") {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Postgres");
  }
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#text-download")]);
  expect(download.suggestedFilename()).toBe("diagram.txt");
  expect(readFileSync((await download.path())!, "utf8")).toContain("Postgres");
  const first = (await out.textContent())!;
  await page.evaluate(() => window.editor!.send({ kind: "direction", key: "", to: "down" }));
  await d.idle();
  await expect.poll(async () => (await out.textContent()) !== first).toBe(true);
  await page.evaluate(() => window.editor!.undo());
  await expect.poll(async () => await out.textContent()).toBe(first);
  await page.keyboard.press("Escape");
  await expect(page.locator("#text-modal")).toBeHidden();
  await openText(page);
  await page.mouse.click(4, 4);
  await expect(page.locator("#text-modal")).toBeHidden();
  await chooseEngine(page, d, "dagre");
  await openText(page);
  await expect(page.locator("#text-note")).toContainText("ELK");
  await expect(out).toContainText("Postgres");
});

test("engines: sketch and theme are written to the file", async ({ page }) => {
  const d = await open(page);
  await menu(page, "#sketch");
  await expect(page.locator("#toast")).toContainText("Sketch: on");
  await d.idle();
  expect(await d.source()).toMatch(/sketch: true/);
  expect(await page.evaluate(() => window.editor!.view!.config.sketch)).toBe(true);
  await page.click("#more");
  await expect(page.locator("#sketch")).toHaveAttribute("aria-checked", "true");
  await page.selectOption("#theme", { label: "Cool Classics" });
  await expect(page.locator("#toast")).toContainText("Theme: Cool Classics");
  await d.idle();
  expect(await d.source()).toMatch(/theme-id: 4/);
  await page.evaluate(() => window.editor!.undo());
  await d.idle();
  await page.evaluate(() => window.editor!.undo());
  await d.idle();
  expect(await d.source()).not.toMatch(/sketch: true/);
});

test("engines: theme pickers list D2's themes, write one key each and say which is in use", async ({ page }) => {
  const d = await open(page);
  await page.click("#more");
  expect(await page.locator("#theme option").count()).toBeGreaterThan(10);
  await expect(page.locator("#dark-theme option")).toHaveText(["Default (Dark Mauve)", "Dark Mauve", "Dark Flagship Terrastruct"]);
  await expect(page.locator("#theme-use")).toBeVisible();
  await expect(page.locator("#dark-theme-use")).toBeHidden();
  await page.selectOption("#theme", { label: "Cool Classics" });
  await expect(page.locator("#toast")).toContainText("Theme: Cool Classics");
  await d.idle();
  expect(await d.source()).toMatch(/theme-id: 4/);
  expect(await d.source()).not.toMatch(/dark-theme-id/);
  await page.click("#more");
  await page.selectOption("#theme", { label: "Default" });
  await expect(page.locator("#toast")).toContainText("Theme: Default");
  await d.idle();
  expect(await d.source()).not.toMatch(/theme-id/);
  await page.click("#more");
  await page.selectOption("#dark-theme", { label: "Dark Mauve" });
  await expect(page.locator("#toast")).toContainText("Dark theme: Dark Mauve");
  await d.idle();
  expect(await d.source()).toMatch(/dark-theme-id: 200/);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.click("#more");
  await expect(page.locator("#dark-theme-use")).toBeVisible();
  await expect(page.locator("#theme-use")).toBeHidden();
  await page.selectOption("#dark-theme", { label: "Default (Dark Mauve)" });
  await d.idle();
  expect(await d.source()).not.toMatch(/dark-theme-id/);
  await page.click("#more");
  await expect(page.locator("#theme-use")).toBeVisible();
});

test("engines: export as SVG and PNG downloads files", async ({ page }) => {
  await open(page);
  const get = async (kind: string) => {
    await page.click("#more");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click(`[data-export="${kind}"]`)]);
    const path = await download.path();
    expect(statSync(path).size).toBeGreaterThan(100);
    return { name: download.suggestedFilename(), bytes: readFileSync(path) };
  };
  const svg = await get("svg");
  expect(svg.name).toBe("diagram.svg");
  expect(svg.bytes.toString("utf8")).toContain("<svg");
  expect(svg.bytes.toString("utf8")).toContain("Postgres");
  const png = await get("png");
  expect(png.name).toBe("diagram.png");
  expect([...png.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});
