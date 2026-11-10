import type { Engine } from "../engine/engine";
import { landsIn, midpoint, nameOf, pathD, within } from "../geometry";
import { svgEl } from "../svg";
import { showTip } from "../ui/toast";
import type { Candidate, Conn, Edit, Path, PendingChange, Point, Shape, Target, View } from "../types";
import { createHits, type EndSlot } from "./hits";
import { mountScene, type Piece } from "./scene";
import { DIRECTIONS, describeConfig } from "./config-text";
import { doneText, pendingFor, pickEnd, pickNode, tipFor, type Zone, type ZoneContext } from "./zones";

const EDGE = 56;
const MAX_SCROLL = 22;
const MIN_SCALE = 0.05;
const MAX_SCALE = 3;
const FIT_MAX = 1.25;
const LIFT = 0.03;
const LIFT_MS = 140;
const KEEP_PX = 96;
const PAD = 40;
const HANDLE_PX = 8;
const HANDLE_HIT_PX = 12;
const HANDLE_HIT_TOUCH_PX = 22;
const MIN_BOX = { w: 48, h: 32 };

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
  piece: Piece;
  path: SVGPathElement;
  srcInside?: boolean;
  mid0: [number, number];
  label: SVGGElement | null;
  hole: SVGGElement | null;
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

type Corner = "nw" | "ne" | "sw" | "se";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Resizing {
  id: string;
  corner: Corner;
  from: Rect;
  rect: Rect;
  min: { w: number; h: number };
  pointer: string;
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
  moving: Piece[];
  attached: Attached[];
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
  deselect(): void;
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
  const wanted = opts.behaviors ?? ["reparent", "reconnect", "pin", "resize"];
  const enabled = new Set(wanted);
  const talaOnly = ["pin", "resize"];
  root.classList.add("d2-root");
  root.innerHTML = `<div class="d2-stage"><svg class="d2-scene d2squared"><defs></defs><style></style><g class="d2-cam"><g class="l-groups"></g><g class="l-conns"></g><g class="l-shapes"></g><g class="l-drag"></g><g class="l-sel"></g><g class="l-ui"></g></g></svg></div>
    <div class="d2-tip" aria-hidden="true" hidden></div>`;
  const q = <T extends Element>(sel: string): T => root.querySelector(sel) as T;
  const stage = q<HTMLElement>(".d2-stage");
  const scene = q<SVGSVGElement>(".d2-scene");
  const cam = q<SVGGElement>(".d2-cam");
  const { pieces, dragLayer, dock, settleAll, sync, clear } = mountScene(scene);
  const selLayer = q<SVGGElement>(".l-sel");
  const over = q<SVGGElement>(".l-ui");
  const tip = q<HTMLElement>(".d2-tip");

  let view: View | null = null;
  let box = { x: 0, y: 0, w: 1, h: 1 };
  let scale = 0.5;
  let tx = 0;
  let ty = 0;
  let fitted = true;
  let insets: Insets = { top: 64, right: 24, bottom: 64, left: 24 };
  let selected = "";
  let drag: Drag | null = null;
  let resizing: Resizing | null = null;
  let drawnScale = 0;
  let gesture: Gesture | null = null;
  let spaceDown = false;
  let armed = "";
  let flight = 0;
  const touches = new Map<number, Point>();
  let busy = false;
  let pendingExternal: View | null = null;
  let hover: string | null = null;
  let shapes = new Map<string, Shape>();
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
    engine: view!.config.engine,
  });

  const rect = (): DOMRect => rectCache ?? (rectCache = stage.getBoundingClientRect());
  window.addEventListener("resize", () => {
    rectCache = null;
  });

  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

  function boundsOf(v: View): typeof box {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const s of v.shapes) {
      x0 = Math.min(x0, s.x);
      y0 = Math.min(y0, s.y);
      x1 = Math.max(x1, s.x + s.width);
      y1 = Math.max(y1, s.y + s.height);
    }
    for (const c of v.conns) {
      for (const [x, y] of c.route) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
    if (x0 > x1) return { x: 0, y: 0, w: 1, h: 1 };
    return { x: x0 - PAD, y: y0 - PAD, w: x1 - x0 + 2 * PAD, h: y1 - y0 + 2 * PAD };
  }

  function applyTransform(): void {
    rectCache = null;
    cam.setAttribute("transform", `translate(${tx} ${ty}) scale(${scale})`);
    let grid = 24 * scale;
    while (grid < 14) grid *= 2;
    stage.style.setProperty("--grid", `${grid}px`);
    stage.style.setProperty("--grid-x", `${tx}px`);
    stage.style.setProperty("--grid-y", `${ty}px`);
    if (scale !== drawnScale) drawSelection();
  }

  function keepVisible(): void {
    const w = stage.clientWidth - insets.right;
    const h = stage.clientHeight - insets.bottom;
    tx = clamp(tx, KEEP_PX - (box.x + box.w) * scale, w - KEEP_PX - box.x * scale);
    ty = clamp(ty, KEEP_PX - (box.y + box.h) * scale, h - KEEP_PX - box.y * scale);
  }

  function moveView(next: { scale: number; tx: number; ty: number }): void {
    const resized = next.scale !== scale;
    scale = next.scale;
    tx = next.tx;
    ty = next.ty;
    if (!view) return;
    applyTransform();
    if (resized) emit("zoom", scale);
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
    return { scale: s, tx: insets.left + (aw - box.w * s) / 2 - box.x * s, ty: insets.top + (ah - box.h * s) / 2 - box.y * s };
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
    if (!view) return;
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
    else if (view) {
      keepVisible();
      applyTransform();
    }
  }

  function reveal(id: string): void {
    const s = shapes.get(id);
    if (!s) return;
    const c = { x: (s.x + s.width / 2) * scale + tx, y: (s.y + s.height / 2) * scale + ty };
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
    if (view && fitted) fit();
  }).observe(stage);

  function toDiagram(ev: { clientX: number; clientY: number }): Point {
    const r = rect();
    return { x: (ev.clientX - r.left - tx) / scale, y: (ev.clientY - r.top - ty) / scale };
  }

  function toScreen(p: Point): Point {
    const r = rect();
    return { x: r.left + p.x * scale + tx, y: r.top + p.y * scale + ty };
  }

  const { hitShape, endSlots, hitEnd, nearConn } = createHits(() => ({ view: view!, scale, reconnect: enabled.has("reconnect"), armed }));

  const isTouch = (type: string): boolean => type === "touch";

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

  const corners = (s: Shape): [Corner, number, number][] => [
    ["nw", s.x, s.y],
    ["ne", s.x + s.width, s.y],
    ["sw", s.x, s.y + s.height],
    ["se", s.x + s.width, s.y + s.height],
  ];

  const resizable = (id: string): Shape | undefined => {
    const s = shapes.get(id);
    return s && enabled.has("resize") && s.type !== "sql_table" ? s : undefined;
  };

  function drawSelection(): void {
    selLayer.replaceChildren();
    drawnScale = scale;
    const s = selected ? shapes.get(selected) : undefined;
    if (!s) return;
    svgEl("rect", { x: s.x - 3, y: s.y - 3, width: s.width + 6, height: s.height + 6, rx: 8, class: "sel-box" }, selLayer);
    if (!resizable(s.id)) return;
    const px = 1 / scale;
    for (const [corner, x, y] of corners(s)) {
      svgEl(
        "rect",
        {
          x: x - (HANDLE_PX / 2) * px,
          y: y - (HANDLE_PX / 2) * px,
          width: HANDLE_PX * px,
          height: HANDLE_PX * px,
          rx: 2 * px,
          class: "handle " + corner,
        },
        selLayer,
      );
    }
  }

  function hitHandle(p: Point, touch = false): Corner | null {
    const s = resizable(selected);
    if (!s || !enabled.has("resize")) return null;
    const reach = (touch ? HANDLE_HIT_TOUCH_PX : HANDLE_HIT_PX) / scale;
    for (const [corner, x, y] of corners(s)) if (Math.hypot(p.x - x, p.y - y) <= reach) return corner;
    return null;
  }

  function minSize(id: string): { w: number; h: number } {
    const text = pieces.get(id)?.el.querySelector("text")?.getBBox();
    return text ? { w: Math.max(MIN_BOX.w, Math.ceil(text.width) + 24), h: Math.max(MIN_BOX.h, Math.ceil(text.height) + 16) } : MIN_BOX;
  }

  function beginResize(ev: PointerEvent, corner: Corner): void {
    const s = shapes.get(selected)!;
    const from = { x: s.x, y: s.y, w: s.width, h: s.height };
    resizing = { id: s.id, corner, from, rect: from, min: minSize(s.id), pointer: ev.pointerType };
    stage.setPointerCapture(ev.pointerId);
    stage.classList.add("resizing");
    hover = null;
    over.replaceChildren();
  }

  function moveResize(ev: PointerEvent): void {
    const r = resizing!;
    const p = toDiagram(ev);
    const { from, min } = r;
    const west = r.corner.includes("w");
    const north = r.corner.startsWith("n");
    const x1 = from.x + from.w;
    const y1 = from.y + from.h;
    const x = west ? Math.min(Math.round(p.x), x1 - min.w) : from.x;
    const y = north ? Math.min(Math.round(p.y), y1 - min.h) : from.y;
    const w = west ? x1 - x : Math.max(Math.round(p.x) - from.x, min.w);
    const h = north ? y1 - y : Math.max(Math.round(p.y) - from.y, min.h);
    r.rect = { x, y, w, h };
    over.replaceChildren();
    svgEl("rect", { x, y, width: w, height: h, rx: 6, class: "resize-box" }, over);
    showTip(tip, `${w} × ${h}`, ev, isTouch(r.pointer));
  }

  async function finishResize(cancelled: boolean): Promise<void> {
    const r = resizing;
    if (!r) return;
    resizing = null;
    stage.classList.remove("resizing");
    tip.hidden = true;
    over.replaceChildren();
    const { rect: n, from } = r;
    if (cancelled || (n.x === from.x && n.y === from.y && n.w === from.w && n.h === from.h) || !view) {
      return;
    }
    busy = true;
    const edit: Edit = { kind: "resize", key: r.id, left: n.x, top: n.y, width: n.w, height: n.h };
    const name = labelOf(r.id);
    try {
      const v = await engine.commit(edit, view.version);
      applyView(v);
      opts.onEdit?.(edit, v.source);
      setStatus(`Resized ${name}`, "done");
    } catch (err) {
      setStatus(String((err as Error).message ?? err), "err");
      if ((err as { status?: number }).status === 409) await refresh();
    } finally {
      busy = false;
      flushExternal();
    }
  }

  function onHover(ev: PointerEvent): void {
    if (drag || busy || !view || gesture) return;
    const touch = isTouch(ev.pointerType);
    const p = toDiagram(ev);
    const corner = hitHandle(p, touch);
    if (corner) {
      hover = `h${corner}`;
      over.replaceChildren();
      stage.style.cursor = corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize";
      return;
    }
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
      const t = `translate(${m[0] - a.mid0[0]} ${m[1] - a.mid0[1]})`;
      a.label.setAttribute("transform", t);
      a.hole?.setAttribute("transform", t);
    }
  }

  function setStatus(text: string, kind: StatusKind = ""): void {
    emit("status", text, kind);
  }

  function labelOf(id: string): string {
    const text = pieces.get(id)?.el.querySelector("text")?.textContent?.trim();
    return text || nameOf(id);
  }

  function tipText(d: Drag): string {
    return d.zone ? tipFor(d.target, d.zone, labelOf) : "";
  }

  function pendingChange(d: Drag): PendingChange | null {
    return pendingFor(d.target, d.zone, d.zone && "key" in d.zone ? d.cands.get(d.zone.key) : undefined, labelOf);
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
        const target = z.to ? shapes.get(z.to) : undefined;
        if (target) svgEl("rect", { x: target.x, y: target.y, width: target.width, height: target.height, rx: 8, class: "target" }, over);
        const landing = d.cands.get(z.key)?.landing;
        if (landing && landsIn(landing, target)) {
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

  const renderTip = (d: Drag): void => showTip(tip, tipText(d), d.client, isTouch(d.pointer));

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
    for (const p of d.moving) p.el.setAttribute("transform", t);
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
    if (d.routeBusy || !d.moved || d.target.kind !== "node" || view!.config.engine !== "tala") return;
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
          d.routed = new Map(res.paths.map((p) => [p.id, p]));
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
    const left = r.left + tx + box.x * scale;
    const top = r.top + ty + box.y * scale;
    if ((vx > 0 && left + box.w * scale <= r.right - insets.right) || (vx < 0 && left >= r.left)) vx = 0;
    if ((vy > 0 && top + box.h * scale <= r.bottom - insets.bottom) || (vy < 0 && top >= r.top)) vy = 0;
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

  function activate(d: Drag): void {
    d.active = true;
    d.stageRect = stage.getBoundingClientRect();
    const v = view!;
    const lift = (c: Conn, srcInside: boolean | undefined): void => {
      const piece = pieces.get(c.id);
      const path = piece?.el.querySelector<SVGPathElement>("path.connection");
      if (!piece || !path) return;
      dragLayer.appendChild(piece.el);
      const label = piece.el.querySelector<SVGGElement>(".label");
      const hole = piece.el.querySelector<SVGGElement>(".hole");
      d.attached.push({ conn: c, piece, path, mid0: midpoint(c.route), label, hole, ...(srcInside === undefined ? {} : { srcInside }) });
    };
    if (d.target.kind === "node") {
      const rootId = d.target.id;
      const idSet = new Set(v.shapes.filter((s) => within(s.id, rootId)).map((s) => s.id));
      const move = (p: Piece | undefined): void => {
        if (!p) return;
        dragLayer.appendChild(p.el);
        d.moving.push(p);
      };
      for (const id of idSet) move(pieces.get(id));
      for (const c of v.conns) {
        const a = idSet.has(c.src);
        const b = idSet.has(c.dst);
        if (a && b) move(pieces.get(c.id));
        else if (a || b) lift(c, a);
      }
      pieces.get(rootId)?.el.classList.add("lift");
      const me = shapes.get(rootId);
      if (me) d.pivot = { x: me.x + me.width / 2, y: me.y + me.height / 2 };
    } else {
      const edge = d.target.edge;
      const c = v.conns.find((x) => x.id === edge);
      if (!c) return;
      lift(c, undefined);
      d.fixed = d.target.end === "dst" ? (c.route[0] ?? null) : (c.route[c.route.length - 1] ?? null);
      d.fixedShape = d.target.end === "dst" ? c.src : c.dst;
    }
    scene.classList.add("dragging");
    stage.classList.add("dragging");
    hover = null;
    d.liftAt = performance.now();
    schedule(d);
  }

  function restoreGroups(d: Drag): void {
    for (const p of d.moving) dock(p);
    for (const a of d.attached) {
      dock(a.piece);
      a.piece.el.innerHTML = a.piece.svg;
    }
    d.moving = [];
    d.attached = [];
    settleAll();
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
    scene.classList.remove("dragging");
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
    if (cancelled || !z || z.kind === "stay" || z.kind === "none" || z.kind === "blocked") {
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
      const floats = d.moving.length && d.target.kind === "node" ? { target: d.target, cur: d.cur } : null;
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
      moving: [],
      attached: [],
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
    if (busy || drag || resizing || !view) return;
    if (ev.button !== 0 && ev.button !== 1) return;
    ev.preventDefault();
    if (ev.button === 1 || spaceDown) {
      stage.setPointerCapture(ev.pointerId);
      return beginGesture(ev);
    }
    const touch = isTouch(ev.pointerType);
    const p = toDiagram(ev);
    const corner = hitHandle(p, touch);
    if (corner) return beginResize(ev, corner);
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
    if (resizing) return moveResize(ev);
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
    if (resizing) void finishResize(ev.type === "pointercancel");
    else if (drag) void finish(drag, ev.type === "pointercancel");
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

  function applyView(v: View, floats: { target: Target; cur: { dx: number; dy: number } } | null = null): void {
    if (v.error) {
      emit("error", v.error);
      if (!view || v.version > view.version) view = { ...(view ?? v), error: v.error, version: v.version };
      return;
    }
    const prev = view?.scene ? view : null;
    const fresh = !prev || v.cause === "open";
    const floating = new Map<string, { dx: number; dy: number }>();
    if (floats?.target.kind === "node" && prev) {
      for (const s of prev.shapes) if (within(s.id, floats.target.id)) floating.set(s.id, floats.cur);
    }
    const old = view;
    view = v;
    for (const name of talaOnly) {
      if (v.config.engine === "tala" && wanted.includes(name)) enabled.add(name);
      else enabled.delete(name);
    }
    shapes = new Map(v.shapes.map((s) => [s.id, s]));
    box = boundsOf(v);
    if (fresh) {
      selected = "";
      armed = "";
      clear();
    }
    sync(v, fresh ? null : prev, floating);
    if (fresh) {
      fit();
      cam.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
    }
    finishApply(old, v);
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

  const DONE: Partial<Record<Edit["kind"], (e: Edit) => string>> = {
    config: (e) => describeConfig(e),
    direction: (e) => `Layout direction: ${DIRECTIONS[e.to ?? ""] ?? e.to ?? ""}`,
    tidy: (e) => `Auto-arranged ${labelOf(e.key)}`,
    unpin: (e) => `Auto-arranged ${e.key ? labelOf(e.key) : "everything"}`,
  };

  async function send(edit: Edit): Promise<void> {
    if (busy || drag || resizing || !view) return;
    busy = true;
    setStatus("Laying out…", "busy");
    try {
      const done = DONE[edit.kind]?.(edit) ?? "Settings changed";
      const v = await engine.commit(edit, view.version);
      applyView(v);
      setStatus(done, "done");
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
    else if (key === "escape" && resizing) void finishResize(true);
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
    deselect: () => select(""),
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
