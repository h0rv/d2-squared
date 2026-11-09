import { expect, type Page } from "@playwright/test";
import type { Point } from "../src/types";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface DragOptions {
  steps?: number;
  hold?: boolean;
  release?: boolean;
  alt?: boolean;
  afterZones?: () => Promise<void>;
}

export interface DragResult {
  status: string;
  diff: string;
  dashed: number;
  highlighted: number;
  frames: number[];
  stats: DragStats | null;
}

const watchToasts = () => {
  if ((window as unknown as { toastErrors?: string[] }).toastErrors) return;
  const seen: string[] = [];
  (window as unknown as { toastErrors: string[] }).toastErrors = seen;
  const toast = document.getElementById("toast");
  if (!toast) return;
  new MutationObserver(() => {
    if (toast.classList.contains("error") && toast.textContent) seen.push(toast.textContent);
  }).observe(toast, { attributes: true, childList: true, subtree: true, characterData: true });
};

const watched: Diagram[] = [];

export async function expectClean(): Promise<void> {
  const all = watched.splice(0);
  for (const d of all) await d.noErrors();
}

export class Diagram {
  readonly errors: string[] = [];

  constructor(readonly page: Page) {
    watched.push(this);
    page.on("pageerror", (e) => this.errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") this.errors.push(m.text());
    });
    void page.addInitScript(`document.addEventListener("DOMContentLoaded", ${watchToasts.toString()})`);
    void page.evaluate(watchToasts).catch(() => {});
  }

  async noErrors(): Promise<void> {
    const toasts = await this.page.evaluate(() => (window as unknown as { toastErrors?: string[] }).toastErrors ?? []).catch(() => []);
    expect([...this.errors, ...toasts]).toEqual([]);
  }

  ready(timeout = 60_000): Promise<unknown> {
    return this.page.waitForFunction(
      () => !!window.editor?.view?.scene && !!document.body.dataset["ready"] && !document.getElementById("loading")?.offsetParent,
      null,
      {
        timeout,
      },
    );
  }

  setScale(scale: number): Promise<void> {
    return this.page.evaluate((s) => window.editor!.setScale(s), scale);
  }

  async center(id: string): Promise<Point> {
    await this.hasShape(id);
    await this.page.evaluate((i) => window.editor!.reveal(i), id);
    await this.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return this.page.evaluate((i) => window.editor!.screenCenter(i), id);
  }

  async openCode(): Promise<void> {
    if ((await this.page.locator("#code-toggle").getAttribute("aria-pressed")) !== "true") await this.page.click("#code-toggle");
    await this.page.locator("#code").waitFor({ state: "visible" });
    await sleep(400);
  }

  at(x: number, y: number): Promise<Point> {
    return this.page.evaluate(([a, b]) => window.editor!.screenPoint(a!, b!), [x, y] as const);
  }

  hasShape(id: string): Promise<unknown> {
    return this.page.waitForFunction((i) => !!window.editor?.shape(i), id, { timeout: 60_000 });
  }

  shape(id: string) {
    return this.page.evaluate((i) => window.editor!.shape(i) ?? null, id);
  }

  async mustShape(id: string) {
    await this.hasShape(id);
    const s = await this.shape(id);
    expect(s, `shape ${id}`).not.toBeNull();
    return s!;
  }

  allShapes(): Promise<Record<string, [number, number]>> {
    return this.page.evaluate(() => Object.fromEntries(window.editor!.view!.shapes.map((s) => [s.id, [s.x, s.y] as [number, number]])));
  }

  async edgeId(src: string, dst: string): Promise<string> {
    const find = ([a, b]: readonly [string, string]) => window.editor?.view?.conns.find((c) => c.src === a && c.dst === b)?.id ?? null;
    await this.page.waitForFunction(find, [src, dst] as const, { timeout: 60_000 });
    return (await this.page.evaluate(find, [src, dst] as const))!;
  }

  async end(edge: string, which: "src" | "dst"): Promise<Point> {
    await this.page.waitForFunction((e) => !!window.editor?.view?.conns.some((c) => c.id === e), edge, { timeout: 60_000 });
    return this.page.evaluate(([e, w]) => window.editor!.endScreen(e, w), [edge, which] as const);
  }

  source(): Promise<string> {
    return this.page.evaluate(() => window.editor!.view!.source);
  }

  idle(timeout = 60_000): Promise<unknown> {
    return this.page.waitForFunction(() => !window.editor!.busy, null, { timeout });
  }

  async drag(from: Point, to: Point, options: DragOptions = {}): Promise<DragResult> {
    const { steps = 24, hold = true, release = true, alt = false } = options;
    const page = this.page;
    await page.evaluate(() => {
      const w = window as unknown as { frames: number[]; stopFrames: boolean };
      w.frames = [];
      w.stopFrames = false;
      let last = performance.now();
      const tick = (n: number) => {
        w.frames.push(n - last);
        last = n;
        if (!w.stopFrames) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    if (alt) await page.keyboard.down("Alt");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      await sleep(12);
    }
    if (hold) await page.waitForFunction(() => !!window.d2Stats?.current?.done, null, { timeout: 60_000 });
    await sleep(250);
    await options.afterZones?.();
    const mid = await page.evaluate(() => {
      const pending = document.querySelector<HTMLElement>("#code.pending #code-lines");
      return {
        status: document.querySelector<HTMLElement>(".d2-tip:not([hidden])")?.textContent ?? "",
        diff: pending ? pending.innerText : "",
        dashed: document.querySelectorAll(".l-ui .prov, .l-ui [stroke-dasharray]").length,
        highlighted: document.querySelectorAll(".l-ui .target, .l-ui .landing").length,
      };
    });
    if (!release) return { ...mid, frames: [], stats: null };
    await page.mouse.up();
    if (alt) await page.keyboard.up("Alt");
    await sleep(100);
    await this.idle();
    await sleep(600);
    const done = await page.evaluate(() => {
      const w = window as unknown as { frames: number[]; stopFrames: boolean };
      w.stopFrames = true;
      return { frames: w.frames.slice(2), last: window.d2Stats?.last ?? null };
    });
    return { ...mid, frames: done.frames, stats: done.last };
  }

  async cancelDrag(): Promise<void> {
    await this.page.keyboard.press("Escape");
    await this.page.mouse.up();
    await sleep(500);
  }

  async colorsAndOrder(): Promise<{ fill: string | null; sameOrder: boolean; hidden: number; leftovers: number }> {
    return this.page.evaluate(() => {
      const shape = document.querySelector(".d2-cam .shape rect, .d2-cam .shape path");
      const fill = shape ? getComputedStyle(shape).fill : null;
      const ids = (layer: string) => [...document.querySelectorAll(`.${layer} > [data-id]`)].map((n) => n.getAttribute("data-id"));
      const v = window.editor!.view!;
      const parents = new Set(v.shapes.map((s) => (s.id.includes(".") ? s.id.slice(0, s.id.lastIndexOf(".")) : "")));
      const depth = (id: string) => id.split(".").length;
      const groups = v.scene.shapes
        .filter((p) => parents.has(p.id))
        .sort((a, b) => depth(a.id) - depth(b.id))
        .map((p) => p.id);
      const leaves = v.scene.shapes.filter((p) => !parents.has(p.id)).map((p) => p.id);
      const conns = v.scene.connections.map((p) => p.id);
      const sameOrder = JSON.stringify([ids("l-groups"), ids("l-conns"), ids("l-shapes")]) === JSON.stringify([groups, conns, leaves]);
      const pieces = [...document.querySelectorAll(".d2-cam [data-id]")];
      const hidden = pieces.filter((g) => g.getAttribute("display") === "none" || getComputedStyle(g).opacity === "0").length;
      const leftovers =
        document.querySelector(".l-drag")!.children.length +
        document.querySelector(".l-ui")!.children.length +
        pieces.filter((g) => g.hasAttribute("transform")).length;
      return { fill, sameOrder, hidden, leftovers };
    });
  }
}

export function frameStats(frames: number[]) {
  const sorted = [...frames].sort((a, b) => a - b);
  const p = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! : NaN);
  return { n: frames.length, p50: p(0.5), p95: p(0.95), max: sorted.at(-1) ?? NaN, over20: frames.filter((f) => f > 20).length };
}
