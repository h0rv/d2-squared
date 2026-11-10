import { expect, test, type Page } from "@playwright/test";

const PAGE = "/d2-squared/";
const MINE = "alpha -> beta\ngamma: {\n  delta\n}\n";

async function ready(page: Page): Promise<void> {
  await page.goto(PAGE);
  await page.waitForFunction(() => !!window.editor?.view?.scene && !!document.body.dataset["ready"], null, { timeout: 60_000 });
}

const source = (page: Page): Promise<string> => page.evaluate(() => window.editor!.view!.source);

async function dropFile(page: Page, name: string, text: string, finish = true): Promise<void> {
  await page.evaluate(
    ({ fileName, content, complete }) => {
      const data = new DataTransfer();
      data.items.add(new File([content], fileName));
      const fire = (type: string) => window.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
      fire("dragenter");
      fire("dragover");
      if (complete) fire("drop");
    },
    { fileName: name, content: text, complete: finish },
  );
}

async function paste(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => value } });
    document.body.dispatchEvent(event);
  }, text);
}

test("open: dropping a file shows the overlay, opens it and can be undone", async ({ page }) => {
  await ready(page);
  const before = await source(page);
  await dropFile(page, "mine.d2", MINE, false);
  await expect(page.locator("#drop")).toBeVisible();
  await expect(page.locator("#drop")).toContainText("Drop your .d2 file to open it");
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.items.add(new File([text], "mine.d2"));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, MINE);
  await expect(page.locator("#toast")).toContainText("Opened mine.d2");
  await expect(page.locator("#toast")).toContainText("Undo");
  await expect(page.locator("#drop")).toBeHidden();
  expect(await source(page)).toBe(MINE);
  await expect(page.locator('[data-example="custom"]')).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('[data-example="custom"]')).toHaveText("mine.d2");
  await page.locator("#toast .toast-action").click();
  await expect.poll(() => source(page)).toBe(before);
  await expect(page.locator('[data-example="architecture"]')).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('[data-example="custom"]')).toHaveCount(0);
});

test("open: a dropped file that is not .d2 or .txt is refused", async ({ page }) => {
  await ready(page);
  const before = await source(page);
  await dropFile(page, "photo.png", "x");
  await expect(page.locator("#toast")).toContainText("Drop a .d2 or .txt file");
  expect(await source(page)).toBe(before);
});

test("open: pasting D2 text opens it, and bad text changes nothing", async ({ page }) => {
  await ready(page);
  const before = await source(page);
  await paste(page, "this -> { is not valid");
  await expect(page.locator("#toast.error")).toBeVisible();
  expect(await source(page)).toBe(before);
  await paste(page, MINE);
  await expect(page.locator("#toast")).toContainText("Pasted your diagram");
  await expect(page.locator("#toast")).toContainText("Undo");
  expect(await source(page)).toBe(MINE);
  await expect(page.locator('[data-example="custom"]')).toHaveAttribute("aria-checked", "true");
});

test("open: pasting into the code editor is left to the editor", async ({ page }) => {
  await ready(page);
  const before = await source(page);
  await page.click("#code-toggle");
  await page.evaluate((text) => {
    const target = document.querySelector("#code textarea, #code [contenteditable]") as HTMLElement;
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
    target.dispatchEvent(event);
  }, MINE);
  await page.waitForTimeout(500);
  await expect(page.locator("#toast")).not.toContainText("Pasted your diagram");
  expect(await source(page)).toBe(before);
});

test("open: Open your own starts a blank diagram with the code panel ready", async ({ page }) => {
  await ready(page);
  await page.click("#open-own");
  await expect(page.locator("#empty")).toBeVisible();
  await expect(page.locator("#code-input")).toBeFocused();
  await expect(page.locator("#code-input")).toHaveAttribute("placeholder", "Paste your D2 here");
  expect(await source(page)).toBe("");
  await page.keyboard.type("api -> db\n");
  await expect(page.locator("#empty")).toBeHidden();
  await expect.poll(() => source(page)).toContain("api -> db");
});

test("open: the blank diagram's upload button opens the file picker", async ({ page, browserName }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });
  await ready(page);
  await page.click("#open-own");
  const chooser = page.waitForEvent("filechooser");
  await page.click("#empty-upload");
  const picker = await chooser;
  if (browserName === "firefox") return;
  await picker.setFiles({ name: "picked.d2", mimeType: "text/plain", buffer: Buffer.from(MINE) });
  await expect(page.locator("#toast")).toContainText("Opened picked.d2");
  expect(await source(page)).toBe(MINE);
  await expect(page.locator("#empty")).toBeHidden();
});

test("open: the first-visit hint mentions dropping a file", async ({ page }) => {
  await ready(page);
  await expect(page.locator("#hint")).toContainText("Drop your own .d2 file here to try it.");
});
