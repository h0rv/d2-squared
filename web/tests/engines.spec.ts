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

test("engines: the text view shows the diagram, copies it and follows edits", async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const d = await open(page);
  await page.click("#view-text");
  const out = page.locator("#text-out");
  await expect(out).toContainText("Postgres");
  await expect(out).toContainText("┌");
  const box = await page.locator("#text-view").boundingBox();
  expect(box!.width).toBeGreaterThan(1000);
  await page.click("#text-ascii");
  await expect(out).not.toContainText("┌");
  await expect(out).toContainText("Postgres");
  await page.click("#text-unicode");
  await expect(out).toContainText("┌");
  await page.click("#text-copy");
  await expect(page.locator("#toast")).toContainText("Copied");
  if (browserName === "chromium") {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Postgres");
  }
  const first = (await out.textContent())!;
  await page.evaluate(() => window.editor!.send({ kind: "direction", key: "", to: "down" }));
  await d.idle();
  await expect.poll(async () => (await out.textContent()) !== first).toBe(true);
  await page.click("#view-diagram");
  await expect(page.locator("#text-view")).toBeHidden();
});

test("engines: export as SVG, PNG and text downloads files", async ({ page }) => {
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
  const text = await get("text");
  expect(text.name).toBe("diagram.txt");
  expect(text.bytes.toString("utf8")).toContain("Postgres");
});
