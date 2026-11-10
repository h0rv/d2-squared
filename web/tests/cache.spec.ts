import { expect, test } from "@playwright/test";
import { Diagram, expectClean } from "./helpers";

test.afterEach(expectClean);

const isWasm = (url: string): boolean => /\/d2squared\.[0-9a-f]+\.wasm$/.test(new URL(url).pathname);

test("cache: the second load takes the engine from Cache Storage with no network", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "Playwright WebKit drops Cache Storage when the page navigates");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (isWasm(request.url())) requests.push(request.url());
  });

  await page.goto("/d2-squared/");
  await new Diagram(page).ready();
  expect(requests).toHaveLength(1);
  const cached = await page.evaluate(async () => (await (await caches.open("d2sq-engine")).keys()).map((key) => key.url));
  expect(cached).toEqual(requests);

  requests.length = 0;
  const texts: string[] = [];
  await page.exposeFunction("recordLoading", (text: string) => texts.push(text));
  await page.addInitScript(() => {
    new MutationObserver(() => {
      const text = document.getElementById("loading-text")?.textContent;
      if (text) void (window as unknown as { recordLoading: (t: string) => void }).recordLoading(text);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.reload();
  const diagram = new Diagram(page);
  await diagram.ready();
  expect(requests).toEqual([]);
  expect(texts).not.toContain("Loading the layout engine…");
  await expect(page.locator("#editor svg").first()).toBeVisible();
});
