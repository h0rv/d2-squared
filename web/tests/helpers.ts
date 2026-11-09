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
  zonesAtDown: { zones: number; prov: number; ms: number };
  frames: number[];
  stats: DragStats | null;
}

export class Diagram {
  readonly errors: string[] = [];

  constructor(readonly page: Page) {
    page.on("pageerror", (e) => this.errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") this.errors.push(m.text());
    });
  }

  noErrors(): void {
    expect(this.errors).toEqual([]);
  }

  ready(timeout = 60_000): Promise<unknown> {
    return this.page.waitForFunction(() => !!window.editor?.view?.svg && !document.getElementById("loading")?.offsetParent, null, {
      timeout,
    });
  }

  setScale(scale: number): Promise<void> {
    return this.page.evaluate((s) => window.editor!.setScale(s), scale);
  }

  async center(id: string): Promise<Point> {
    await this.page.evaluate((i) => {
      const stage = document.querySelector(".d2-stage")!;
      const r = stage.getBoundingClientRect();
      const c = window.editor!.screenCenter(i);
      stage.scrollLeft += Math.max(0, c.x - (r.right - 120)) - Math.max(0, r.left + 120 - c.x);
      stage.scrollTop += Math.max(0, c.y - (r.bottom - 120)) - Math.max(0, r.top + 120 - c.y);
    }, id);
    await this.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return this.page.evaluate((i) => window.editor!.screenCenter(i), id);
  }

  at(x: number, y: number): Promise<Point> {
    return this.page.evaluate(([a, b]) => window.editor!.screenPoint(a!, b!), [x, y] as const);
  }

  shape(id: string) {
    return this.page.evaluate((i) => window.editor!.shape(i) ?? null, id);
  }

  async mustShape(id: string) {
    const s = await this.shape(id);
    expect(s, `shape ${id}`).not.toBeNull();
    return s!;
  }

  allShapes(): Promise<Record<string, [number, number]>> {
    return this.page.evaluate(() => Object.fromEntries(window.editor!.view!.shapes.map((s) => [s.id, [s.x, s.y] as [number, number]])));
  }

  edgeId(src: string, dst: string): Promise<string> {
    return this.page.evaluate(([a, b]) => window.editor!.view!.conns.find((c) => c.src === a && c.dst === b)!.id, [src, dst] as const);
  }

  end(edge: string, which: "src" | "dst"): Promise<Point> {
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
    const downAt = Date.now();
    await page.mouse.down();
    const zonesAtDown = await page.evaluate(() => ({
      zones: document.querySelectorAll(".d2-over .zone").length,
      prov: document.querySelectorAll(".d2-over .zone.prov").length,
      ms: 0,
    }));
    zonesAtDown.ms = Date.now() - downAt;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      await sleep(12);
    }
    if (hold) await page.waitForFunction(() => !!window.d2Stats?.current?.done, null, { timeout: 60_000 });
    await sleep(250);
    await options.afterZones?.();
    const mid = await page.evaluate(() => {
      const diff = document.querySelector<HTMLElement>(".d2-diff")!;
      return { status: document.getElementById("status")!.textContent ?? "", diff: diff.hidden ? "" : diff.innerText };
    });
    if (!release) return { status: mid.status, diff: mid.diff, zonesAtDown, frames: [], stats: null };
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
    return { status: mid.status, diff: mid.diff, zonesAtDown, frames: done.frames, stats: done.last };
  }

  async cancelDrag(): Promise<void> {
    await this.page.keyboard.press("Escape");
    await this.page.mouse.up();
    await sleep(500);
  }

  async colorsAndOrder(): Promise<{ fill: string | null; sameOrder: boolean; hidden: number; leftovers: number }> {
    return this.page.evaluate(() => {
      const shape = document.querySelector(".d2-svg svg .shape rect, .d2-svg svg .shape path");
      const fill = shape ? getComputedStyle(shape).fill : null;
      const inner = document.querySelector(".d2-svg svg > svg")!;
      const hidden = [...inner.querySelectorAll(":scope > g")].filter(
        (g) => g.getAttribute("display") === "none" || getComputedStyle(g).opacity === "0",
      ).length;
      const over = document.querySelector(".d2-over");
      const leftovers = document.querySelectorAll("[data-moving]").length + (over ? over.children.length : 0);
      const tpl = document.createElement("template");
      tpl.innerHTML = window.editor!.view!.svg;
      const key = (n: Element) => (n.tagName === "g" ? "g:" + n.getAttribute("class") : n.tagName);
      const want = [...tpl.content.firstElementChild!.querySelector(":scope > svg")!.children].filter((n) => n.tagName === "g").map(key);
      const have = [...inner.children].filter((n) => n.tagName === "g" && !n.classList.contains("ghost")).map(key);
      return { fill, sameOrder: JSON.stringify(want) === JSON.stringify(have), hidden, leftovers };
    });
  }
}

export function frameStats(frames: number[]) {
  const sorted = [...frames].sort((a, b) => a - b);
  const p = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! : NaN);
  return { n: frames.length, p50: p(0.5), p95: p(0.95), max: sorted.at(-1) ?? NaN, over20: frames.filter((f) => f > 20).length };
}
