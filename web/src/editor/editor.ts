import type { Engine } from "../engine/engine";
import { cls, contains, depth, midpoint, nameOf, pathD, within } from "../geometry";
import { parseSvg, svgEl } from "../svg";
import type { Candidate, Conn, Edit, Path, PendingChange, Point, Shape, Target, View } from "../types";
import { doneText, pickEnd, pickNode, tipFor, type Zone, type ZoneContext } from "./zones";

const EASE = "cubic-bezier(.2,.8,.2,1)";
const TWEEN_MS = 260;
const EDGE = 56;
const MAX_SCROLL = 22;
const FAN_PX = 16;
const FAN_HIT_PX = 9;
const END_HIT_PX = 14;
const END_HIT_TOUCH_PX = 22;
const ARROW_HIT_PX = 9;
const ARROW_HIT_TOUCH_PX = 18;
const MIN_SCALE = 0.05;
const MAX_SCALE = 3;
const FIT_MAX = 1.25;
const LIFT = 0.03;
const LIFT_MS = 140;
const KEEP_PX = 96;

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type StatusKind = "" | "busy" | "done" | "err";

export interface EditorOptions {
  behaviors?: string[];
  hoverOutline?: boolean;
  onEdit?: (edit: Edit, source: string) => void;
}

interface Attached {
  conn: Conn;
  path: SVGPathElement;
  srcInside?: boolean;
  mid0: [number, number];
  label?: SVGGElement;
}

interface Gesture {
  kind: "pan" | "pinch";
  id: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  scale: number;
  dist: number;
}

interface FloatLayer {
  outer: SVGSVGElement;
  inner: SVGSVGElement;
  marker(id: string): string;
}

interface Drag {
  target: Target;
  start: Point;
  ptr: Point;
  cur: { dx: number; dy: number };
  moved: boolean;
  active: boolean;
  finishing: boolean;
  abort: AbortController;
  cands: Map<string, Candidate>;
  asked: Set<string>;
  groups: Element[];
  attached: Attached[];
  hidden: Element[];
  float: FloatLayer | null;
  client: { clientX: number; clientY: number };
  zone: Zone | null;
  raf: number;
  routeBusy: boolean;
  routeSeq: number;
  routeApplied: number;
  routed: Map<string, Path> | null;
  routedDelta: { dx: number; dy: number } | null;
  lastRoute: { dx: number; dy: number } | null;
  done: boolean;
  alt: boolean;
  t0: number;
  screen: Point;
  stats: DragStats;
  stageRect: DOMRect | null;
  fixed: [number, number] | null;
  fixedShape: string;
  pointer: string;
  pivot: Point;
  liftAt: number;
  lift: number;
  pending: string;
  overlay: string;
  onKey: (e: KeyboardEvent) => void;
}

export interface EditorEvents {
  status: (text: string, kind: StatusKind) => void;
  view: (view: View, prev: View | null) => void;
  select: (id: string) => void;
  zoom: (scale: number) => void;
  pending: (change: PendingChange | null) => void;
  error: (message: string | null) => void;
}

export interface Editor {
  on<K extends keyof EditorEvents>(name: K, fn: EditorEvents[K]): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
  send(edit: Edit): Promise<void>;
  fit(animate?: boolean): void;
  setScale(scale: number): void;
  zoomBy(factor: number): void;
  setInsets(insets: Insets, animate?: boolean): void;
  reveal(id: string): void;
  label(id: string): string;
  readonly scale: number;
  readonly fitted: boolean;
  readonly view: View | null;
  readonly selected: string;
  readonly busy: boolean;
  screenCenter(id: string): Point;
  screenPoint(x: number, y: number): Point;
  endScreen(edge: string, end: "src" | "dst"): Point;
  shape(id: string): Shape | undefined;
}

export function mount(root: HTMLElement, engine: Engine, opts: EditorOptions = {}): Editor {
  const enabled = new Set(opts.behaviors ?? ["reparent", "reconnect", "pin"]);
  root.classList.add("d2-root");
  root.innerHTML = `<div class="d2-stage"><div class="d2-canvas"><div class="d2-svg"></div><svg class="d2-sel"></svg><svg class="d2-over"></svg></div></div>
    <div class="d2-tip" aria-hidden="true" hidden></div>`;
  const q = <T extends Element>(sel: string): T => root.querySelector(sel) as T;
  const stage = q<HTMLElement>(".d2-stage");
  const canvas = q<HTMLElement>(".d2-canvas");
  const svgHost = q<HTMLElement>(".d2-svg");
  const over = q<SVGSVGElement>(".d2-over");
  const selLayer = q<SVGSVGElement>(".d2-sel");
  const tip = q<HTMLElement>(".d2-tip");

  let view: View | null = null;
  let outer: SVGSVGElement | null = null;
  let inner: SVGSVGElement | null = null;
  let box = { x: 0, y: 0, w: 1, h: 1 };
  let scale = 0.5;
  let tx = 0;
  let ty = 0;
  let fitted = true;
  let insets: Insets = { top: 64, right: 24, bottom: 64, left: 24 };
  let selected = "";
  let drag: Drag | null = null;
  let gesture: Gesture | null = null;
  let spaceDown = false;
  let armed = "";
  let flight = 0;
  const touches = new Map<number, Point>();
  let busy = false;
  let pendingExternal: View | null = null;
  let hover: string | null = null;
  let shapes = new Map<string, Shape>();
  let groups = new Map<string, Element>();
  let orderTarget: string[] | null = null;
  let rectCache: DOMRect | null = null;
  const stats: NonNullable<Window["d2Stats"]> = { drags: [], last: null };
  window.d2Stats = stats;
  const listeners: { [K in keyof EditorEvents]: EditorEvents[K][] } = {
    status: [],
    view: [],
    select: [],
    zoom: [],
    pending: [],
    error: [],
  };
  const emit = <K extends keyof EditorEvents>(name: K, ...args: Parameters<EditorEvents[K]>) => {
    for (const fn of listeners[name]) (fn as (...a: Parameters<EditorEvents[K]>) => void)(...args);
  };

  const zoneContext = (): ZoneContext => ({
    view: view!,
    shapes,
    scale,
    enabled,
  });

  function indexView(v: View): void {
    shapes = new Map(v.shapes.map((s) => [s.id, s]));
    groups = new Map();
    for (const child of inner!.children) {
      const c = child.getAttribute("class");
      if (child.tagName === "g" && c && c !== "shape") groups.set(c, child);
    }
  }

  function readBox(): void {
    const [x = 0, y = 0, w = 1, h = 1] = inner!.getAttribute("viewBox")!.split(" ").map(Number);
    box = { x, y, w, h };
  }

  const rect = (): DOMRect => rectCache ?? (rectCache = outer!.getBoundingClientRect());
  window.addEventListener("resize", () => {
    rectCache = null;
  });

  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

  function applyTransform(): void {
    rectCache = null;
    canvas.style.transform = `translate(${tx}px, ${ty}px)`;
    let grid = 24 * scale;
    while (grid < 14) grid *= 2;
    stage.style.setProperty("--grid", `${grid}px`);
    stage.style.setProperty("--grid-x", `${tx}px`);
    stage.style.setProperty("--grid-y", `${ty}px`);
  }

  function sizeCanvas(): void {
    const w = box.w * scale;
    const h = box.h * scale;
    outer!.setAttribute("width", String(w));
    outer!.setAttribute("height", String(h));
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    for (const layer of [over, selLayer]) {
      layer.setAttribute("width", String(w));
      layer.setAttribute("height", String(h));
      layer.setAttribute("viewBox", `${box.x} ${box.y} ${box.w} ${box.h}`);
    }
    applyTransform();
  }

  function mountFresh(v: View): void {
    orderTarget = null;
    const p = parseSvg(v.svg);
    svgHost.replaceChildren(p.outer);
    outer = p.outer;
    inner = p.inner;
    readBox();
    sizeCanvas();
    indexView(v);
    canvas.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
  }

  function keepVisible(): void {
    const w = stage.clientWidth - insets.right;
    const h = stage.clientHeight - insets.bottom;
    tx = clamp(tx, KEEP_PX - box.w * scale, w - KEEP_PX);
    ty = clamp(ty, KEEP_PX - box.h * scale, h - KEEP_PX);
  }

  function moveView(next: { scale: number; tx: number; ty: number }): void {
    const resized = next.scale !== scale;
    scale = next.scale;
    tx = next.tx;
    ty = next.ty;
    if (!view || !outer) return;
    if (resized) {
      sizeCanvas();
      emit("zoom", scale);
    } else {
      applyTransform();
    }
  }

  function cancelFlight(): void {
    flight++;
  }

  function zoomAt(next: number, cx: number, cy: number): void {
    cancelFlight();
    const r = stage.getBoundingClientRect();
    const px = cx - r.left;
    const py = cy - r.top;
    const s = clamp(next, MIN_SCALE, MAX_SCALE);
    const k = s / scale;
    fitted = false;
    moveView({ scale: s, tx: px - (px - tx) * k, ty: py - (py - ty) * k });
    keepVisible();
    applyTransform();
  }

  function setScale(s: number): void {
    const r = stage.getBoundingClientRect();
    zoomAt(s, r.left + (stage.clientWidth - insets.right) / 2, r.top + (stage.clientHeight - insets.bottom) / 2);
  }

  function zoomBy(factor: number): void {
    setScale(scale * factor);
  }

  function panBy(dx: number, dy: number): void {
    cancelFlight();
    fitted = false;
    tx += dx;
    ty += dy;
    keepVisible();
    applyTransform();
  }

  function fitTarget(): { scale: number; tx: number; ty: number } {
    const aw = Math.max(stage.clientWidth - insets.left - insets.right, 40);
    const ah = Math.max(stage.clientHeight - insets.top - insets.bottom, 40);
    const s = clamp(Math.min(aw / box.w, ah / box.h), MIN_SCALE, FIT_MAX);
    return { scale: s, tx: insets.left + (aw - box.w * s) / 2, ty: insets.top + (ah - box.h * s) / 2 };
  }

  function fly(to: { scale: number; tx: number; ty: number }, ms = 260): void {
    const from = { scale, tx, ty };
    const id = ++flight;
    const t0 = performance.now();
    const tick = (now: number) => {
      if (id !== flight) return;
      const k = Math.min((now - t0) / ms, 1);
      const e = 1 - Math.pow(1 - k, 3);
      const mix = (a: number, b: number) => a + (b - a) * e;
      moveView({ scale: Math.exp(mix(Math.log(from.scale), Math.log(to.scale))), tx: mix(from.tx, to.tx), ty: mix(from.ty, to.ty) });
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function fit(animate = false): void {
    if (!view || !outer) return;
    fitted = true;
    const target = fitTarget();
    if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) fly(target);
    else {
      cancelFlight();
      moveView(target);
    }
  }

  function setInsets(next: Insets, animate = false): void {
    insets = next;
    if (fitted) fit(animate);
    else if (view && outer) {
      keepVisible();
      applyTransform();
    }
  }

  function reveal(id: string): void {
    const s = shapes.get(id);
    if (!s) return;
    const c = { x: (s.x + s.width / 2 - box.x) * scale + tx, y: (s.y + s.height / 2 - box.y) * scale + ty };
    const w = stage.clientWidth - insets.right;
    const h = stage.clientHeight - insets.bottom;
    const m = 120;
    const dx = Math.max(0, c.x - (w - m)) - Math.max(0, m - c.x);
    const dy = Math.max(0, c.y - (h - m)) - Math.max(0, m - c.y);
    if (dx || dy) {
      tx -= dx;
      ty -= dy;
      fitted = false;
      applyTransform();
    }
  }

  new ResizeObserver(() => {
    rectCache = null;
    if (view && outer && fitted) fit();
  }).observe(stage);

  function toDiagram(ev: { clientX: number; clientY: number }): Point {
    const r = rect();
    return { x: box.x + (ev.clientX - r.left) / scale, y: box.y + (ev.clientY - r.top) / scale };
  }

  function toScreen(p: Point): Point {
    const r = rect();
    return { x: r.left + (p.x - box.x) * scale, y: r.top + (p.y - box.y) * scale };
  }

  function hitShape(p: Point): Shape | null {
    let best: Shape | null = null;
    for (const s of view!.shapes) {
      if (!contains(s, p)) continue;
      if (!best || depth(s.id) > depth(best.id) || (depth(s.id) === depth(best.id) && s.width * s.height < best.width * best.height))
        best = s;
    }
    return best;
  }

  interface EndSlot {
    conn: Conn;
    end: "src" | "dst";
    pt: [number, number];
    next: [number, number];
    at: Point;
    siblings: number;
    key: string;
  }

  let slotCache: { version: number; scale: number; slots: EndSlot[] } | null = null;

  function endSlots(): EndSlot[] {
    const v = view!;
    if (slotCache && slotCache.version === v.version && slotCache.scale === scale) return slotCache.slots;
    const groupsByKey = new Map<string, EndSlot[]>();
    for (const conn of v.conns) {
      for (const end of ["src", "dst"] as const) {
        const route = end === "src" ? conn.route : [...conn.route].reverse();
        const pt = route[0];
        const next = route[1];
        if (!pt || !next) continue;
        const key = `${end === "src" ? conn.src : conn.dst}|${Math.round(pt[0] / 4)}|${Math.round(pt[1] / 4)}`;
        const slot: EndSlot = { conn, end, pt, next, at: { x: pt[0], y: pt[1] }, siblings: 1, key };
        groupsByKey.set(key, [...(groupsByKey.get(key) ?? []), slot]);
      }
    }
    const slots: EndSlot[] = [];
    for (const group of groupsByKey.values()) {
      group.forEach((slot, i) => {
        slot.siblings = group.length;
        if (group.length > 1) {
          const dx = slot.next[0] - slot.pt[0];
          const dy = slot.next[1] - slot.pt[1];
          const len = Math.hypot(dx, dy) || 1;
          const spread = ((i - (group.length - 1) / 2) * FAN_PX) / scale;
          slot.at = { x: slot.pt[0] + (-dy / len) * spread, y: slot.pt[1] + (dx / len) * spread };
        }
        slots.push(slot);
      });
    }
    slotCache = { version: v.version, scale, slots };
    return slots;
  }

  const isTouch = (type: string): boolean => type === "touch";

  function hitEnd(p: Point, touch = false): EndSlot | null {
    if (!enabled.has("reconnect")) return null;
    let best: EndSlot | null = null;
    let bestDist = Infinity;
    for (const slot of endSlots()) {
      if (touch && armed !== slot.conn.id) continue;
      const px = slot.siblings > 1 ? FAN_HIT_PX : touch ? END_HIT_TOUCH_PX : END_HIT_PX;
      const d = Math.hypot(slot.at.x - p.x, slot.at.y - p.y);
      if (d < px / scale && d < bestDist) {
        best = slot;
        bestDist = d;
      }
    }
    return best;
  }

  function segmentDist(p: Point, a: [number, number], b: [number, number]): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = dx * dx + dy * dy;
    const k = len === 0 ? 0 : clamp(((p.x - a[0]) * dx + (p.y - a[1]) * dy) / len, 0, 1);
    return Math.hypot(p.x - (a[0] + k * dx), p.y - (a[1] + k * dy));
  }

  function nearConn(p: Point, touch = false): Conn | null {
    if (!enabled.has("reconnect")) return null;
    const reach = (touch ? ARROW_HIT_TOUCH_PX : ARROW_HIT_PX) / scale;
    let best: Conn | null = null;
    let bestDist = reach;
    for (const conn of view!.conns) {
      for (let i = 1; i < conn.route.length; i++) {
        const d = segmentDist(p, conn.route[i - 1]!, conn.route[i]!);
        if (d <= bestDist) {
          best = conn;
          bestDist = d;
        }
      }
    }
    return best;
  }

  function drawHandles(conn: Conn | null, end: EndSlot | null, shape: Shape | null): void {
    over.replaceChildren();
    const px = 1 / scale;
    if (conn) {
      const mine = endSlots().filter((s) => s.conn.id === conn.id);
      const keys = new Set(mine.filter((s) => s.siblings > 1).map((s) => s.key));
      const cluster = endSlots().filter((s) => keys.has(s.key));
      for (const key of keys) {
        const group = cluster.filter((s) => s.key === key);
        const first = group[0]!.at;
        const last = group[group.length - 1]!.at;
        svgEl("line", { x1: first.x, y1: first.y, x2: last.x, y2: last.y, class: "fan-bar", "stroke-width": 16 * px }, over);
      }
      for (const slot of cluster) {
        if (slot.conn.id !== conn.id) svgEl("circle", { cx: slot.at.x, cy: slot.at.y, r: 4 * px, class: "end-dot faint" }, over);
      }
      for (const slot of mine) {
        const on = slot === end;
        svgEl("circle", { cx: slot.at.x, cy: slot.at.y, r: (on ? 8 : 6) * px, class: "end-dot" + (on ? " on" : "") }, over);
      }
    } else if (shape && opts.hoverOutline !== false) {
      svgEl("rect", { x: shape.x, y: shape.y, width: shape.width, height: shape.height, rx: 6, class: "hover-box" }, over);
    }
  }

  function drawSelection(): void {
    selLayer.replaceChildren();
    const s = selected ? shapes.get(selected) : undefined;
    if (!s) return;
    svgEl("rect", { x: s.x - 3, y: s.y - 3, width: s.width + 6, height: s.height + 6, rx: 8, class: "sel-box" }, selLayer);
  }

  function onHover(ev: PointerEvent): void {
    if (drag || busy || !view || gesture) return;
    const touch = isTouch(ev.pointerType);
    const p = toDiagram(ev);
    const end = hitEnd(p, touch);
    const conn = end ? end.conn : nearConn(p, touch);
    const shape = conn ? null : hitShape(p);
    const key = conn ? `c${conn.id}${end ? end.end : ""}` : shape ? `s${shape.id}` : "";
    if (key === hover) return;
    hover = key;
    drawHandles(conn, end, shape);
    stage.style.cursor = spaceDown ? "grab" : end ? "crosshair" : shape ? "grab" : "default";
  }

  function setPath(a: Attached, pts: [number, number][]): void {
    a.path.setAttribute("d", pathD(pts, a.path.hasAttribute("marker-start"), a.path.hasAttribute("marker-end")));
    if (a.label) {
      const m = midpoint(pts);
      a.label.setAttribute("transform", `translate(${m[0] - a.mid0[0]} ${m[1] - a.mid0[1]})`);
    }
  }

  const groupOf = (id: string): Element | undefined => groups.get(cls(id));

  function setStatus(text: string, kind: StatusKind = ""): void {
    emit("status", text, kind);
  }

  function labelOf(id: string): string {
    const text = groupOf(id)?.querySelector("text")?.textContent?.trim();
    return text || nameOf(id);
  }

  function tipText(d: Drag): string {
    return d.zone ? tipFor(d.target, d.zone, labelOf) : "";
  }

  function pendingChange(d: Drag): PendingChange | null {
    const z = d.zone;
    if (!z || z.kind === "stay" || z.kind === "none") return null;
    const title = tipText(d);
    if (z.kind === "pin") {
      return {
        title,
        lines: [
          { op: "+", text: `left: ${z.left}` },
          { op: "+", text: `top: ${z.top}` },
        ],
      };
    }
    const cand = d.cands.get(z.key);
    if (!cand) return { title, working: true };
    return { title, lines: cand.diff, saved: cand.pinLines };
  }

  function renderOverlay(d: Drag): void {
    const z = d.zone;
    const px = 1 / scale;
    if (d.target.kind === "node") {
      const key = z && z.kind === "move" ? `${z.key}|${d.cands.has(z.key)}` : "";
      if (key === d.overlay) return;
      d.overlay = key;
      over.replaceChildren();
      if (z && z.kind === "move") {
        const target = z.to ? shapes.get(z.to) : null;
        if (target) svgEl("rect", { x: target.x, y: target.y, width: target.width, height: target.height, rx: 8, class: "target" }, over);
        const landing = d.cands.get(z.key)?.landing;
        const inside =
          !target ||
          (landing &&
            landing.x >= target.x &&
            landing.y >= target.y &&
            landing.x + landing.width <= target.x + target.width &&
            landing.y + landing.height <= target.y + target.height);
        if (landing && inside) {
          svgEl("rect", { x: landing.x, y: landing.y, width: landing.width, height: landing.height, rx: 6, class: "landing" }, over);
        }
      }
      return;
    }
    over.replaceChildren();
    if (z && z.kind === "reconnect") {
      const s = shapes.get(z.shape);
      if (s) {
        svgEl("rect", { x: s.x, y: s.y, width: s.width, height: s.height, rx: 6, class: "target" }, over);
        const cols = s.cols ?? [];
        if (z.row >= 0 && cols.length > 0) {
          const rh = s.height / (cols.length + 1);
          svgEl("rect", { x: s.x, y: s.y + rh * (z.row + 1), width: s.width, height: rh, class: "row" }, over);
        }
      }
    }
    svgEl("circle", { cx: d.ptr.x, cy: d.ptr.y, r: 7 * px, class: "end-dot on" }, over);
  }

  function renderTip(d: Drag): void {
    const text = tipText(d);
    if (!text) {
      tip.hidden = true;
      return;
    }
    if (tip.textContent !== text) tip.textContent = text;
    tip.hidden = false;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const touch = isTouch(d.pointer);
    let x = d.client.clientX + 16;
    let y = touch ? d.client.clientY - h - 48 : d.client.clientY + 20;
    if (x + w > window.innerWidth - 8) x = d.client.clientX - w - 16;
    if (y + h > window.innerHeight - 8) y = d.client.clientY - h - 16;
    tip.style.transform = `translate3d(${Math.max(8, x)}px, ${Math.max(8, y)}px, 0)`;
  }

  function publishPending(d: Drag): void {
    const model = pendingChange(d);
    const key = model ? `${model.title}|${model.working ? "w" : (model.lines?.length ?? 0)}` : "";
    if (key === d.pending) return;
    d.pending = key;
    emit("pending", model);
  }

  function ensureCandidate(d: Drag, z: Zone | null): void {
    if (!z || !("edit" in z) || !z.edit || z.kind === "pin") return;
    const key = z.key;
    if (d.cands.has(key) || d.asked.has(key)) return;
    d.asked.add(key);
    engine.candidate(z.edit, view!.version, d.abort.signal).then(
      (c) => {
        if (drag !== d) return;
        d.cands.set(c.key, c);
        schedule(d);
      },
      () => {},
    );
  }

  function floatTransform(d: Drag, dx: number, dy: number, lift: number): string {
    const { x, y } = d.pivot;
    return `translate(${dx} ${dy}) translate(${x} ${y}) scale(${lift}) translate(${-x} ${-y})`;
  }

  function applyFloat(d: Drag): void {
    const t = floatTransform(d, d.cur.dx, d.cur.dy, d.lift);
    for (const g of d.groups) g.setAttribute("transform", t);
  }

  function attachedPath(d: Drag, a: Attached): [number, number][] {
    const base = d.routed?.get(a.conn.id);
    const pts = (base ? base.route : a.conn.route).map((p): [number, number] => [p[0], p[1]]);
    const dx = base && d.routedDelta ? d.cur.dx - d.routedDelta.dx : d.cur.dx;
    const dy = base && d.routedDelta ? d.cur.dy - d.routedDelta.dy : d.cur.dy;
    const i = a.srcInside ? 0 : pts.length - 1;
    const end = pts[i];
    if (end) pts[i] = [end[0] + dx, end[1] + dy];
    if (!base) return [pts[0]!, pts[pts.length - 1]!];
    return pts;
  }

  function drawAttached(d: Drag): void {
    for (const a of d.attached) setPath(a, attachedPath(d, a));
  }

  function maybeRoute(d: Drag): void {
    if (d.routeBusy || !d.moved || d.target.kind !== "node") return;
    const { dx, dy } = d.cur;
    if (d.lastRoute && Math.hypot(dx - d.lastRoute.dx, dy - d.lastRoute.dy) < 1.5 / scale) return;
    d.routeBusy = true;
    d.lastRoute = { dx, dy };
    const seq = ++d.routeSeq;
    const sent = performance.now();
    engine.route(d.target, { x: dx, y: dy }, view!.version, d.abort.signal).then(
      (res) => {
        d.routeBusy = false;
        if (drag !== d && !d.finishing) return;
        d.stats.routeMs.push(performance.now() - sent);
        if (seq > d.routeApplied) {
          d.routeApplied = seq;
          d.routed = new Map((res.paths ?? []).map((p) => [p.id, p]));
          d.routedDelta = { dx, dy };
          if (drag === d) {
            drawAttached(d);
            schedule(d);
          }
        }
      },
      () => {
        d.routeBusy = false;
      },
    );
  }

  function schedule(d: Drag): void {
    if (d.raf || drag !== d) return;
    d.raf = requestAnimationFrame(() => frame(d));
  }

  function frame(d: Drag): void {
    d.raf = 0;
    if (drag !== d || !d.active) return;
    const t0 = performance.now();
    const panned = autoPan(d);
    if (panned) d.ptr = toDiagram(d.client);
    d.cur = { dx: d.ptr.x - d.start.x, dy: d.ptr.y - d.start.y };
    d.lift = 1 + LIFT * Math.min(1, (t0 - d.liftAt) / LIFT_MS);
    if (d.target.kind === "node") {
      applyFloat(d);
      drawAttached(d);
      d.zone = pickNode(zoneContext(), { id: d.target.id, ptr: d.ptr, cur: d.cur, moved: d.moved, alt: d.alt });
    } else {
      const a = d.attached[0];
      const fixed = d.fixed;
      if (a && fixed) {
        const here: [number, number] = [d.ptr.x, d.ptr.y];
        setPath(a, d.target.end === "dst" ? [fixed, here] : [here, fixed]);
      }
      d.zone = pickEnd(zoneContext(), { edge: d.target.edge, end: d.target.end, ptr: d.ptr, moved: d.moved, fixedShape: d.fixedShape });
    }
    ensureCandidate(d, d.zone);
    renderOverlay(d);
    renderTip(d);
    publishPending(d);
    maybeRoute(d);
    d.stats.frameWork.push(performance.now() - t0);
    if (panned || d.lift < 1 + LIFT) schedule(d);
  }

  function autoPan(d: Drag): boolean {
    const r = d.stageRect;
    if (!r) return false;
    const c = d.client;
    const speed = (p: number, lo: number, hi: number) =>
      (p < lo + EDGE ? -Math.min(1, (lo + EDGE - p) / EDGE) : p > hi - EDGE ? Math.min(1, (p - (hi - EDGE)) / EDGE) : 0) * MAX_SCROLL;
    let vx = speed(c.clientX, r.left, r.right - insets.right);
    let vy = speed(c.clientY, r.top, r.bottom - insets.bottom);
    const cr = canvas.getBoundingClientRect();
    if ((vx > 0 && cr.right <= r.right - insets.right) || (vx < 0 && cr.left >= r.left)) vx = 0;
    if ((vy > 0 && cr.bottom <= r.bottom - insets.bottom) || (vy < 0 && cr.top >= r.top)) vy = 0;
    if (!vx && !vy) return false;
    const x0 = tx;
    const y0 = ty;
    cancelFlight();
    fitted = false;
    tx -= vx;
    ty -= vy;
    keepVisible();
    applyTransform();
    return tx !== x0 || ty !== y0;
  }

  function startPreview(d: Drag): void {
    void (async () => {
      try {
        for await (const msg of engine.preview(d.target, d.start, view!.version, d.abort.signal)) {
          if (drag !== d && !d.finishing) return;
          const t = performance.now() - d.t0;
          if ("candidate" in msg) {
            d.cands.set(msg.candidate.key, msg.candidate);
            d.stats.firstZoneMs ??= t;
            d.stats.arrivals.push(t);
          } else {
            d.done = true;
            d.stats.allZonesMs = t;
            if (stats.current === d) stats.current = d;
          }
          schedule(d);
        }
      } catch (err) {
        if (!(err instanceof Error) || err.name !== "AbortError") setStatus(String((err as Error).message ?? err), "err");
      }
    })();
  }

  function makeFloat(): FloatLayer {
    const o = outer!.cloneNode(false) as SVGSVGElement;
    const i = inner!.cloneNode(false) as SVGSVGElement;
    o.setAttribute("class", "d2-float");
    o.appendChild(i);
    canvas.insertBefore(o, selLayer);
    const markers = new Map<string, string>();
    return {
      outer: o,
      inner: i,
      marker(id: string): string {
        let copy = markers.get(id);
        if (!copy) {
          const src = inner!.querySelector(`marker[id="${id}"]`);
          if (src) {
            const dup = src.cloneNode(true) as Element;
            dup.setAttribute("id", id + "-f");
            i.appendChild(dup);
          }
          copy = id + "-f";
          markers.set(id, copy);
        }
        return copy;
      },
    };
  }

  function floatClone(d: Drag, group: Element): Element {
    const c = group.cloneNode(true) as Element;
    for (const m of c.querySelectorAll("marker")) m.remove();
    for (const n of c.querySelectorAll("[marker-start],[marker-end],[mask]")) {
      n.removeAttribute("mask");
      for (const a of ["marker-start", "marker-end"]) {
        const m = /url\(#(.+)\)/.exec(n.getAttribute(a) ?? "");
        if (m?.[1]) n.setAttribute(a, `url(#${d.float!.marker(m[1])})`);
      }
    }
    d.float!.inner.appendChild(c);
    for (const child of group.children) {
      if (child.tagName !== "marker") {
        child.setAttribute("display", "none");
        d.hidden.push(child);
      }
    }
    return c;
  }

  function wrapExtras(gc: Element, path: Element): SVGGElement | undefined {
    const extras = Array.from(gc.children).filter((n) => n !== path && n.tagName !== "marker");
    if (extras.length === 0) return undefined;
    const wrap = svgEl("g", { class: "edge-label" }, gc);
    for (const n of extras) wrap.appendChild(n);
    return wrap;
  }

  function activate(d: Drag): void {
    d.active = true;
    d.float = makeFloat();
    d.stageRect = stage.getBoundingClientRect();
    const v = view!;
    if (d.target.kind === "node") {
      const rootId = d.target.id;
      const ids = v.shapes.filter((s) => within(s.id, rootId)).map((s) => s.id);
      const idSet = new Set(ids);
      const moving = ids.map(groupOf).filter((g): g is Element => !!g);
      const insideGroups: Element[] = [];
      const edges: { conn: Conn; group: Element; srcInside: boolean }[] = [];
      for (const c of v.conns) {
        const a = idSet.has(c.src);
        const b = idSet.has(c.dst);
        const g = groupOf(c.id);
        if (!g) continue;
        if (a && b) insideGroups.push(g);
        else if (a || b) edges.push({ conn: c, group: g, srcInside: a });
      }
      const rootGroup = groupOf(rootId);
      d.groups = [...moving, ...insideGroups].map((g) => {
        const clone = floatClone(d, g);
        if (g === rootGroup) clone.classList.add("lift");
        return clone;
      });
      const me = shapes.get(rootId);
      if (me) d.pivot = { x: me.x + me.width / 2, y: me.y + me.height / 2 };
      for (const e of edges) {
        const gc = floatClone(d, e.group);
        const path = gc.querySelector("path");
        if (!path) continue;
        const label = wrapExtras(gc, path);
        d.attached.push({ conn: e.conn, path, srcInside: e.srcInside, mid0: midpoint(e.conn.route), ...(label ? { label } : {}) });
      }
    } else {
      const edge = d.target.edge;
      const c = v.conns.find((x) => x.id === edge);
      const g = c && groupOf(c.id);
      if (!c || !g) return;
      const gc = floatClone(d, g);
      const path = gc.querySelector("path");
      if (!path) return;
      const label = wrapExtras(gc, path);
      d.attached.push({ conn: c, path, mid0: midpoint(c.route), ...(label ? { label } : {}) });
      d.fixed = d.target.end === "dst" ? (c.route[0] ?? null) : (c.route[c.route.length - 1] ?? null);
      d.fixedShape = d.target.end === "dst" ? c.src : c.dst;
    }
    canvas.classList.add("dragging");
    stage.classList.add("dragging");
    hover = null;
    d.liftAt = performance.now();
    schedule(d);
  }

  function restoreGroups(d: Drag): void {
    for (const n of d.hidden) n.removeAttribute("display");
    d.hidden = [];
    d.float?.outer.remove();
    d.float = null;
  }

  function tween(
    from: { dx: number; dy: number },
    to: { dx: number; dy: number },
    ms: number,
    step: (x: number, y: number, k: number) => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now: number) => {
        const k = Math.min((now - t0) / ms, 1);
        const e = 1 - Math.pow(1 - k, 3);
        step(from.dx + (to.dx - from.dx) * e, from.dy + (to.dy - from.dy) * e, e);
        if (k < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  function endDrag(): void {
    canvas.classList.remove("dragging");
    stage.classList.remove("dragging");
    tip.hidden = true;
    emit("pending", null);
  }

  async function settleBack(d: Drag): Promise<void> {
    busy = true;
    endDrag();
    over.replaceChildren();
    if (d.target.kind === "node") {
      const from = d.lift;
      await tween({ ...d.cur }, { dx: 0, dy: 0 }, 160, (x, y, k) => {
        d.cur = { dx: x, dy: y };
        d.lift = 1 + (from - 1) * (1 - k);
        applyFloat(d);
        drawAttached(d);
      });
    }
    restoreGroups(d);
    busy = false;
    flushExternal();
  }

  async function finish(d: Drag, cancelled: boolean): Promise<void> {
    if (drag !== d) return;
    cancelAnimationFrame(d.raf);
    d.finishing = true;
    drag = null;
    endDrag();
    window.removeEventListener("keydown", d.onKey);
    if (!d.active) {
      d.abort.abort();
      over.replaceChildren();
      if (!cancelled && d.target.kind === "node") select(d.target.id);
      if (!cancelled && isTouch(d.pointer)) armConn(nearConn(toDiagram(d.client), true));
      return;
    }
    const z = d.zone;
    if (cancelled || !z || z.kind === "stay" || z.kind === "none") {
      d.abort.abort();
      return settleBack(d);
    }
    const dropAt = performance.now();
    busy = true;
    const message = doneText(d.target, z, labelOf);
    const cand = "key" in z ? d.cands.get(z.key) : undefined;
    const moved = d.target.kind === "node" ? shapes.get(d.target.id) : undefined;
    if (z.kind === "move" && cand && moved) {
      const from = d.lift;
      void tween({ ...d.cur }, { dx: cand.landing.x - moved.x, dy: cand.landing.y - moved.y }, 200, (x, y, k) => {
        d.cur = { dx: x, dy: y };
        d.lift = 1 + (from - 1) * (1 - k);
        applyFloat(d);
        drawAttached(d);
      });
    } else {
      d.lift = 1;
      if (d.target.kind === "node") applyFloat(d);
    }
    over.replaceChildren();
    try {
      const v = await engine.commit(z.edit, view!.version);
      d.abort.abort();
      d.stats.commitServerMs = v.ms;
      const floats = d.groups.length && d.target.kind === "node" ? { target: d.target, cur: d.cur } : null;
      restoreGroups(d);
      applyView(v, floats);
      d.stats.dropToViewMs = performance.now() - dropAt;
      stats.drags.push(d.stats);
      stats.last = d.stats;
      opts.onEdit?.(z.edit, v.source);
      setStatus(message, "done");
    } catch (err) {
      d.abort.abort();
      setStatus(String((err as Error).message ?? err), "err");
      restoreGroups(d);
      if ((err as { status?: number }).status === 409) await refresh();
    } finally {
      busy = false;
      flushExternal();
    }
  }

  function beginDrag(ev: PointerEvent, target: Target): void {
    const start = toDiagram(ev);
    const d: Drag = {
      target,
      start,
      ptr: start,
      cur: { dx: 0, dy: 0 },
      moved: false,
      active: false,
      finishing: false,
      abort: new AbortController(),
      cands: new Map(),
      asked: new Set(),
      groups: [],
      attached: [],
      hidden: [],
      float: null,
      client: { clientX: ev.clientX, clientY: ev.clientY },
      zone: null,
      raf: 0,
      routeBusy: false,
      routeSeq: 0,
      routeApplied: 0,
      routed: null,
      routedDelta: null,
      lastRoute: null,
      done: false,
      alt: ev.altKey,
      t0: performance.now(),
      screen: { x: ev.clientX, y: ev.clientY },
      stageRect: null,
      fixed: null,
      fixedShape: "",
      pointer: ev.pointerType,
      pivot: start,
      liftAt: 0,
      lift: 1,
      pending: "",
      overlay: "",
      stats: { kind: target.kind, firstZoneMs: null, allZonesMs: null, arrivals: [], routeMs: [], frameWork: [] },
      onKey: (e) => {
        if (e.key === "Escape") void finish(d, true);
      },
    };
    window.addEventListener("keydown", d.onKey);
    drag = d;
    stats.current = d;
    stage.setPointerCapture(ev.pointerId);
    d.zone = { kind: target.kind === "node" ? "stay" : "none" };
    hover = null;
    over.replaceChildren();
    d.stats.planMs = performance.now() - d.t0;
    startPreview(d);
  }

  function armConn(conn: Conn | null): void {
    armed = conn?.id ?? "";
    hover = conn ? `c${conn.id}` : "";
    drawHandles(conn, null, null);
  }

  function beginGesture(ev: PointerEvent): void {
    const pts = [...touches.values()];
    if (pts.length >= 2) {
      const [a, b] = pts as [Point, Point];
      gesture = {
        kind: "pinch",
        id: ev.pointerId,
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        tx,
        ty,
        scale,
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      };
    } else {
      gesture = { kind: "pan", id: ev.pointerId, x: ev.clientX, y: ev.clientY, tx, ty, scale, dist: 1 };
    }
    cancelFlight();
    hover = null;
    over.replaceChildren();
    stage.classList.add("panning");
  }

  function moveGesture(ev: PointerEvent): void {
    const g = gesture!;
    if (g.kind === "pan") {
      fitted = false;
      tx = g.tx + ev.clientX - g.x;
      ty = g.ty + ev.clientY - g.y;
      keepVisible();
      applyTransform();
      return;
    }
    const pts = [...touches.values()];
    if (pts.length < 2) return;
    const [a, b] = pts as [Point, Point];
    const r = stage.getBoundingClientRect();
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const s = clamp(g.scale * (dist / g.dist), MIN_SCALE, MAX_SCALE);
    const k = s / g.scale;
    const px = g.x - r.left;
    const py = g.y - r.top;
    fitted = false;
    moveView({ scale: s, tx: cx - r.left - (px - g.tx) * k, ty: cy - r.top - (py - g.ty) * k });
    keepVisible();
    applyTransform();
  }

  function endGesture(): void {
    gesture = null;
    stage.classList.remove("panning");
  }

  function onDown(ev: PointerEvent): void {
    if (ev.pointerType === "touch") {
      touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (touches.size >= 2) {
        if (drag) void finish(drag, true);
        ev.preventDefault();
        stage.setPointerCapture(ev.pointerId);
        beginGesture(ev);
        return;
      }
    }
    if (busy || drag || !view) return;
    if (ev.button !== 0 && ev.button !== 1) return;
    ev.preventDefault();
    if (ev.button === 1 || spaceDown) {
      stage.setPointerCapture(ev.pointerId);
      return beginGesture(ev);
    }
    const touch = isTouch(ev.pointerType);
    const p = toDiagram(ev);
    const end = hitEnd(p, touch);
    if (end) return beginDrag(ev, { kind: "edgeEnd", edge: end.conn.id, end: end.end });
    const s = hitShape(p);
    if (s) return beginDrag(ev, { kind: "node", id: s.id });
    select("");
    armConn(touch ? nearConn(p, true) : null);
    if (!touch || !armed) {
      stage.setPointerCapture(ev.pointerId);
      beginGesture(ev);
    }
  }

  function onMove(ev: PointerEvent): void {
    if (touches.has(ev.pointerId)) touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (gesture) return moveGesture(ev);
    if (!drag) return onHover(ev);
    const d = drag;
    d.client = { clientX: ev.clientX, clientY: ev.clientY };
    d.ptr = toDiagram(ev);
    d.alt = ev.altKey;
    if (!d.moved && Math.hypot(ev.clientX - d.screen.x, ev.clientY - d.screen.y) > 4) {
      d.moved = true;
      activate(d);
    }
    if (d.active) schedule(d);
  }

  function onUp(ev: PointerEvent): void {
    touches.delete(ev.pointerId);
    if (gesture) {
      if (gesture.kind === "pinch" && touches.size === 1) {
        const [rest] = [...touches.entries()] as [[number, Point]];
        gesture = { kind: "pan", id: rest[0], x: rest[1].x, y: rest[1].y, tx, ty, scale, dist: 1 };
        return;
      }
      if (touches.size === 0 || gesture.kind === "pan") endGesture();
      return;
    }
    if (drag) void finish(drag, ev.type === "pointercancel");
  }

  function wheel(ev: WheelEvent): void {
    ev.preventDefault();
    if (drag || busy) return;
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? stage.clientHeight : 1;
    if (ev.ctrlKey || ev.metaKey) {
      zoomAt(scale * Math.exp(-clamp(ev.deltaY * unit, -60, 60) * 0.01), ev.clientX, ev.clientY);
    } else {
      panBy(-ev.deltaX * unit, -ev.deltaY * unit);
    }
  }

  function select(id: string): void {
    selected = id;
    drawSelection();
    emit("select", id);
  }

  function tweenEl(node: Element, from: Point, ms = TWEEN_MS): Animation | null {
    if (!node.animate) return null;
    return node.animate([{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: "translate(0px, 0px)" }], {
      duration: ms,
      easing: EASE,
    });
  }

  function fade(node: Element, from: number, to: number, ms = TWEEN_MS): Animation | null {
    return node.animate ? node.animate([{ opacity: from }, { opacity: to }], { duration: ms, easing: "ease-out" }) : null;
  }

  function keyOf(node: Element): string {
    if (node.tagName === "g") return "g:" + node.getAttribute("class");
    return node.tagName + ":" + (node.getAttribute("id") ?? "");
  }

  function applyView(v: View, floats: { target: Target; cur: { dx: number; dy: number } } | null = null): void {
    if (v.error) {
      emit("error", v.error);
      if (!view || v.version > view.version) view = { ...(view ?? v), error: v.error, version: v.version };
      return;
    }
    settleOrder();
    const prev = view;
    if (!prev || (prev.error && !prev.svg) || v.cause === "open" || !outer || !inner) {
      view = v;
      selected = "";
      armed = "";
      mountFresh(v);
      fit();
      finishApply(prev, v);
      return;
    }
    const p = parseSvg(v.svg);
    const oldBox = box;
    const floating = new Map<string, { dx: number; dy: number }>();
    if (floats && floats.target.kind === "node") {
      const rootId = floats.target.id;
      for (const s of prev.shapes) if (within(s.id, rootId)) floating.set(s.id, floats.cur);
    }
    for (const g of inner.querySelectorAll(":scope > g[transform]")) g.removeAttribute("transform");
    const oldChildren = new Map<string, Element>();
    for (const child of inner.children) oldChildren.set(keyOf(child), child);
    inner.setAttribute("viewBox", p.inner.getAttribute("viewBox") ?? "");
    for (const name of ["width", "height"]) inner.setAttribute(name, p.inner.getAttribute(name) ?? "");
    outer.setAttribute("viewBox", p.outer.getAttribute("viewBox") ?? "");
    view = v;
    readBox();
    sizeCanvas();
    const ghosts: Element[] = [];
    const animations: (Animation | null)[] = [];
    const origin = { x: box.x - oldBox.x, y: box.y - oldBox.y };
    const newShapeByClass = new Map(v.shapes.map((s) => [cls(s.id), s]));
    const oldShapeByClass = new Map(prev.shapes.map((s) => [cls(s.id), s]));
    const desired: { node: Element; old: Element | undefined; reused: boolean; cls: string }[] = [];
    for (const child of Array.from(p.inner.children)) {
      const old = oldChildren.get(keyOf(child));
      const reused = !!old && old.outerHTML === child.outerHTML;
      desired.push({ node: reused && old ? old : child, old, reused, cls: child.getAttribute("class") ?? "" });
    }
    const live = new Set(desired.map((x) => x.node));
    for (const old of oldChildren.values()) if (!live.has(old)) old.remove();
    let cursor = inner.firstElementChild;
    for (const x of desired) {
      if (x.node === cursor) {
        cursor = cursor.nextElementSibling;
        continue;
      }
      inner.insertBefore(x.node, cursor);
    }
    for (const x of desired) {
      if (x.node.parentNode !== inner) continue;
      const sh = newShapeByClass.get(x.cls);
      const osh = oldShapeByClass.get(x.cls);
      if (x.reused) {
        if (origin.x || origin.y) animations.push(tweenEl(x.node, { x: -origin.x, y: -origin.y }));
        continue;
      }
      if (sh) {
        const f = floating.get(sh.id) ?? { dx: 0, dy: 0 };
        if (osh && osh.width === sh.width && osh.height === sh.height) {
          const off = { x: osh.x + f.dx - sh.x - origin.x, y: osh.y + f.dy - sh.y - origin.y };
          if (Math.abs(off.x) > 0.5 || Math.abs(off.y) > 0.5) {
            animations.push(tweenEl(x.node, off));
            (x.node as HTMLElement).dataset["moving"] = "1";
          }
        } else {
          animations.push(fade(x.node, 0, 1));
          if (x.old) ghosts.push(x.old);
        }
      } else if (x.node.tagName === "g") {
        animations.push(fade(x.node, 0, 1));
        if (x.old) ghosts.push(x.old);
      }
    }
    for (const g of ghosts) {
      const clone = g.cloneNode(true) as Element;
      clone.classList.add("ghost");
      inner.insertBefore(clone, inner.firstElementChild);
      const a = fade(clone, 1, 0);
      (a ? a.finished : Promise.resolve()).then(
        () => clone.remove(),
        () => clone.remove(),
      );
    }
    for (const n of inner.querySelectorAll(':scope > g[data-moving="1"]')) inner.appendChild(n);
    indexView(v);
    const finished = animations.filter((a): a is Animation => !!a).map((a) => a.finished.catch(() => {}));
    orderTarget = desired.map((x) => x.cls);
    void Promise.all(finished).then(settleOrder);
    setTimeout(settleOrder, 1500);
    finishApply(prev, v);
  }

  function settleOrder(): void {
    const target = orderTarget;
    if (!target || !inner) return;
    const want = target.map((c) => groups.get(c) ?? null);
    const present = want.filter((n): n is Element => !!n);
    const cur = Array.from(inner.children).filter((n) => present.includes(n));
    if (cur.some((n, i) => n !== present[i])) for (const n of present) inner.insertBefore(n, inner.querySelector(":scope > mask"));
    for (const n of inner.querySelectorAll("[data-moving]")) delete (n as HTMLElement).dataset["moving"];
  }

  function finishApply(prev: View | null, v: View): void {
    hover = null;
    over.replaceChildren();
    if (selected && !shapes.has(selected)) selected = "";
    drawSelection();
    emit("error", null);
    emit("view", v, prev);
    if (prev && fitted && v.cause !== "open") window.setTimeout(() => fitted && !drag && !busy && fit(true), 320);
  }

  async function refresh(): Promise<void> {
    const v = await engine.current();
    if (v) applyView(v);
  }

  function flushExternal(): void {
    if (pendingExternal && (!view || pendingExternal.version > view.version) && !drag && !busy) {
      const v = pendingExternal;
      pendingExternal = null;
      applyView(v);
    }
  }

  async function history(kind: "undo" | "redo"): Promise<void> {
    if (busy || drag) return;
    busy = true;
    try {
      const v = await engine[kind]();
      applyView(v);
      setStatus(kind === "undo" ? "Undone" : "Redone", "done");
    } catch (err) {
      setStatus(String((err as Error).message ?? err), "err");
    } finally {
      busy = false;
      flushExternal();
    }
  }

  async function send(edit: Edit): Promise<void> {
    if (busy || drag || !view) return;
    busy = true;
    setStatus("Laying out…", "busy");
    try {
      const v = await engine.commit(edit, view.version);
      applyView(v);
      setStatus(edit.kind === "direction" ? "Layout direction changed" : "Layout reset", "done");
    } catch (err) {
      setStatus(String((err as Error).message ?? err), "err");
    } finally {
      busy = false;
      flushExternal();
    }
  }

  engine.subscribe((v) => {
    if (drag || busy) {
      if (!pendingExternal || v.version > pendingExternal.version) pendingExternal = v;
    } else {
      applyView(v);
    }
  });

  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);
  stage.addEventListener("wheel", wheel, { passive: false });
  stage.addEventListener("pointerleave", () => {
    if (!drag && !gesture) {
      hover = null;
      if (!armed) over.replaceChildren();
    }
  });
  stage.addEventListener("dblclick", (ev) => {
    if (!view || busy || drag) return;
    const p = toDiagram(ev);
    const s = hitShape(p);
    if (s?.pinned) void send({ kind: "unpin", key: s.id });
    else if (!s && !nearConn(p)) fit(true);
  });
  const typing = (target: EventTarget | null): boolean => /input|textarea|select/i.test((target as HTMLElement | null)?.tagName ?? "");
  window.addEventListener("keydown", (e) => {
    if (typing(e.target)) return;
    const key = e.key.toLowerCase();
    if (e.metaKey || e.ctrlKey) {
      if (key !== "z" && key !== "y") return;
      e.preventDefault();
      void history(key === "y" || e.shiftKey ? "redo" : "undo");
      return;
    }
    if (e.altKey) return;
    if (key === "f") fit(true);
    else if (key === "escape" && !drag && selected) select("");
    else if (key === " " && !spaceDown && (e.target === document.body || stage.contains(e.target as Node))) {
      spaceDown = true;
      stage.classList.add("hand");
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === " ") {
      spaceDown = false;
      stage.classList.remove("hand");
    }
  });
  window.addEventListener("blur", () => {
    spaceDown = false;
    stage.classList.remove("hand");
  });

  void refresh();

  const center = (id: string): Point => {
    const s = shapes.get(id);
    if (!s) throw new Error(`unknown shape ${id}`);
    return toScreen({ x: s.x + s.width / 2, y: s.y + s.height / 2 });
  };

  return {
    on: (name, fn) => {
      (listeners[name] as unknown[]).push(fn);
    },
    undo: () => history("undo"),
    redo: () => history("redo"),
    send,
    fit,
    setScale,
    zoomBy,
    setInsets,
    reveal,
    label: labelOf,
    get scale() {
      return scale;
    },
    get fitted() {
      return fitted;
    },
    get view() {
      return view;
    },
    get selected() {
      return selected;
    },
    get busy() {
      return busy || !!drag;
    },
    screenCenter: center,
    screenPoint: (x, y) => toScreen({ x, y }),
    endScreen: (edge, end) => {
      const slot = view && endSlots().find((s) => s.conn.id === edge && s.end === end);
      if (!slot) throw new Error(`unknown edge end ${edge}`);
      return toScreen(slot.at);
    },
    shape: (id) => shapes.get(id),
  };
}
