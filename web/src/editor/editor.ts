import type { Engine } from "../engine/engine";
import { cls, contains, depth, midpoint, nameOf, pathD, within } from "../geometry";
import { parseSvg, svgEl } from "../svg";
import type { Candidate, Conn, Edit, Path, Point, Shape, Target, View } from "../types";
import { renderDiff, type DiffModel } from "./diff-panel";
import { doneText, pickEnd, pickNode, planEnd, planNode, statusFor, type PlanItem, type Zone, type ZoneContext } from "./zones";

const EASE = "cubic-bezier(.2,.8,.2,1)";
const TWEEN_MS = 260;
const READABLE = 0.78;
const EDGE = 56;
const MAX_SCROLL = 22;
const FAN_PX = 16;
const FAN_HIT_PX = 7;

export type StatusKind = "" | "busy" | "done" | "err";

export interface EditorOptions {
  behaviors?: string[];
  hoverOutline?: boolean;
  hint?: () => string;
  onEdit?: (edit: Edit, source: string) => void;
}

interface Attached {
  conn: Conn;
  path: SVGPathElement;
  srcInside?: boolean;
  mid0: [number, number];
  label?: SVGGElement;
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
  plan: PlanItem[];
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
  onKey: (e: KeyboardEvent) => void;
}

export interface EditorEvents {
  status: (text?: string, kind?: StatusKind, title?: string) => void;
  view: (view: View, prev: View | null) => void;
  select: (id: string) => void;
}

export interface Editor {
  on<K extends keyof EditorEvents>(name: K, fn: EditorEvents[K]): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
  send(edit: Edit): Promise<void>;
  fit(): void;
  setScale(scale: number): void;
  readonly scale: number;
  readonly view: View | null;
  readonly selected: string;
  readonly busy: boolean;
  screenCenter(id: string): Point;
  screenPoint(x: number, y: number): Point;
  endScreen(edge: string, end: "src" | "dst"): Point;
  shape(id: string): Shape | undefined;
  statusLine(): string;
}

export function mount(root: HTMLElement, engine: Engine, opts: EditorOptions = {}): Editor {
  const enabled = new Set(opts.behaviors ?? ["reparent", "reconnect", "pin"]);
  root.classList.add("d2-root");
  root.innerHTML = `<div class="d2-stage"><div class="d2-canvas"><div class="d2-svg"></div><svg class="d2-over"></svg></div></div>
    <div class="d2-diff" hidden></div>`;
  const q = <T extends Element>(sel: string): T => root.querySelector(sel) as T;
  const stage = q<HTMLElement>(".d2-stage");
  const canvas = q<HTMLElement>(".d2-canvas");
  const svgHost = q<HTMLElement>(".d2-svg");
  const over = q<SVGSVGElement>(".d2-over");
  const diffBox = q<HTMLElement>(".d2-diff");

  let view: View | null = null;
  let outer: SVGSVGElement | null = null;
  let inner: SVGSVGElement | null = null;
  let box = { x: 0, y: 0, w: 1, h: 1 };
  let scale = 0.5;
  let selected = "";
  let drag: Drag | null = null;
  let busy = false;
  let pendingExternal: View | null = null;
  let hover: string | null = null;
  let shapes = new Map<string, Shape>();
  let groups = new Map<string, Element>();
  let orderTarget: SVGSVGElement | null = null;
  let rectCache: DOMRect | null = null;
  const stats: NonNullable<Window["d2Stats"]> = { drags: [], last: null };
  window.d2Stats = stats;
  const listeners: { [K in keyof EditorEvents]: EditorEvents[K][] } = { status: [], view: [], select: [] };
  const emit = <K extends keyof EditorEvents>(name: K, ...args: Parameters<EditorEvents[K]>) => {
    for (const fn of listeners[name]) (fn as (...a: Parameters<EditorEvents[K]>) => void)(...args);
  };

  const zoneContext = (): ZoneContext => ({
    view: view!,
    shapes,
    scale,
    enabled,
    canvasBox: box,
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
  stage.addEventListener("scroll", () => {
    rectCache = null;
  });
  window.addEventListener("resize", () => {
    rectCache = null;
  });

  function sizeCanvas(): void {
    rectCache = null;
    const w = box.w * scale;
    const h = box.h * scale;
    outer!.setAttribute("width", String(w));
    outer!.setAttribute("height", String(h));
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    over.setAttribute("width", String(w));
    over.setAttribute("height", String(h));
    over.setAttribute("viewBox", `${box.x} ${box.y} ${box.w} ${box.h}`);
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
  }

  function setScale(s: number): void {
    scale = Math.min(Math.max(s, 0.1), 2);
    if (view && outer) sizeCanvas();
    emit("status");
  }

  function fit(): void {
    if (!view) return;
    const w = (stage.clientWidth - 24) / box.w;
    const h = (stage.clientHeight - 24) / box.h;
    setScale(Math.min(Math.max(Math.min(w, h), Math.min(w, READABLE)), 1.5));
  }

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
        const slot: EndSlot = { conn, end, pt, next, at: { x: pt[0], y: pt[1] }, siblings: 1 };
        const key = `${end === "src" ? conn.src : conn.dst}|${Math.round(pt[0] / 4)}|${Math.round(pt[1] / 4)}`;
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

  function hitEnd(p: Point): EndSlot | null {
    if (!enabled.has("reconnect")) return null;
    let best: EndSlot | null = null;
    let bestDist = Infinity;
    for (const slot of endSlots()) {
      const radius = (slot.siblings > 1 ? FAN_HIT_PX : 11) / scale;
      const d = Math.hypot(slot.at.x - p.x, slot.at.y - p.y);
      if (d < radius && d < bestDist) {
        best = slot;
        bestDist = d;
      }
    }
    return best;
  }

  function nearCluster(p: Point): EndSlot[] {
    const reach = (FAN_PX * 2.5) / scale;
    return endSlots().filter((s) => s.siblings > 1 && Math.hypot(s.pt[0] - p.x, s.pt[1] - p.y) < reach);
  }

  function drawHover(end: EndSlot | null, shape: Shape | null, cluster: EndSlot[]): void {
    over.replaceChildren();
    for (const slot of cluster) {
      svgEl("circle", { cx: slot.at.x, cy: slot.at.y, r: 5 / scale, class: "end-dot" + (slot === end ? "" : " faint") }, over);
    }
    if (end && !cluster.includes(end)) {
      svgEl("circle", { cx: end.at.x, cy: end.at.y, r: 6 / scale, class: "end-dot" }, over);
    } else if (!end && cluster.length === 0 && shape && opts.hoverOutline !== false) {
      svgEl("rect", { x: shape.x, y: shape.y, width: shape.width, height: shape.height, rx: 4, class: "hover-box" }, over);
    }
  }

  function onHover(ev: PointerEvent): void {
    if (drag || busy || !view) return;
    const p = toDiagram(ev);
    const end = hitEnd(p);
    const cluster = end ? (end.siblings > 1 ? nearCluster({ x: end.pt[0], y: end.pt[1] }) : []) : nearCluster(p);
    const shape = end || cluster.length ? null : hitShape(p);
    const key = end
      ? `e${end.conn.id}${end.end}`
      : cluster.length
        ? `c${cluster[0]!.conn.id}${cluster[0]!.end}`
        : shape
          ? `s${shape.id}`
          : "";
    if (key === hover) return;
    hover = key;
    drawHover(end, shape, cluster);
    canvas.style.cursor = end ? "crosshair" : shape ? "grab" : "default";
  }

  function setPath(a: Attached, pts: [number, number][]): void {
    a.path.setAttribute("d", pathD(pts, a.path.hasAttribute("marker-start"), a.path.hasAttribute("marker-end")));
    if (a.label) {
      const m = midpoint(pts);
      a.label.setAttribute("transform", `translate(${m[0] - a.mid0[0]} ${m[1] - a.mid0[1]})`);
    }
  }

  const groupOf = (id: string): Element | undefined => groups.get(cls(id));

  function setStatus(text: string, kind: StatusKind = "", title = ""): void {
    emit("status", text, kind, title);
  }

  function zoneModel(d: Drag): DiffModel | null {
    const z = d.zone;
    if (!z || z.kind === "stay" || z.kind === "none") return null;
    if (z.kind === "pin") {
      return {
        title: `Place ${nameOf(d.target.kind === "node" ? d.target.id : "")}`,
        lines: [
          { op: "+", text: `left: ${z.left}` },
          { op: "+", text: `top: ${z.top}` },
        ],
      };
    }
    const cand = d.cands.get(z.key);
    if (!cand) return { title: z.title, pending: true };
    return { title: z.title, lines: cand.diff, pins: cand.pinLines };
  }

  function renderOverlay(d: Drag): void {
    over.replaceChildren();
    const z = d.zone;
    const px = 1 / scale;
    if (d.target.kind === "node") {
      const me = shapes.get(d.target.id);
      if (!me) return;
      svgEl(
        "rect",
        { x: me.x, y: me.y, width: me.width, height: me.height, rx: 6, class: "zone origin" + (z && z.kind === "stay" ? " active" : "") },
        over,
      );
      for (const p of d.plan) {
        const c = d.cands.get(p.key);
        const on = z && z.kind === "move" && z.key === p.key;
        const l = c ? c.landing : p.box;
        svgEl(
          "rect",
          { x: l.x, y: l.y, width: l.width, height: l.height, rx: 6, class: "zone" + (c ? "" : " prov") + (on ? " active" : "") },
          over,
        );
      }
      if (z && z.kind === "move") {
        const target = z.to ? shapes.get(z.to) : null;
        if (target) svgEl("rect", { x: target.x, y: target.y, width: target.width, height: target.height, rx: 8, class: "target" }, over);
        const l = d.cands.get(z.key)?.landing ?? d.plan.find((p) => p.key === z.key)?.box;
        if (l) {
          const t = svgEl("text", { x: l.x, y: l.y - 8 * px, class: "zone-label", "font-size": 12 * px }, over);
          t.textContent = z.title;
        }
      }
      if (z && z.kind === "pin") {
        const t = svgEl("text", { class: "zone-label pin", x: me.x + d.cur.dx, y: me.y + d.cur.dy - 8 * px, "font-size": 12 * px }, over);
        t.textContent = "place here";
      }
    } else {
      for (const p of d.plan) {
        const exact = d.cands.has(p.key);
        const on = z && z.kind === "reconnect" && z.shape === p.shape;
        svgEl(
          "rect",
          {
            x: p.box.x,
            y: p.box.y,
            width: p.box.width,
            height: p.box.height,
            rx: 4,
            class: "zone" + (exact ? "" : " prov") + (on ? " active" : ""),
          },
          over,
        );
      }
      if (z && z.kind === "reconnect") {
        const s = shapes.get(z.shape);
        if (!s) return;
        svgEl("rect", { x: s.x, y: s.y, width: s.width, height: s.height, rx: 4, class: "target" }, over);
        const cols = s.cols ?? [];
        if (z.row >= 0 && cols.length > 0) {
          const rh = s.height / (cols.length + 1);
          svgEl("rect", { x: s.x, y: s.y + rh * (z.row + 1), width: s.width, height: rh, class: "row" }, over);
        }
      }
    }
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

  function applyFloat(d: Drag): void {
    const t = `translate(${d.cur.dx} ${d.cur.dy})`;
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
    const scrolled = autoscroll(d);
    if (scrolled) d.ptr = toDiagram(d.client);
    d.cur = { dx: d.ptr.x - d.start.x, dy: d.ptr.y - d.start.y };
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
    renderDiffFor(d);
    setStatus(statusFor(d.target, d.zone), "busy");
    maybeRoute(d);
    d.stats.frameWork.push(performance.now() - t0);
    if (scrolled) schedule(d);
  }

  function renderDiffFor(d: Drag | null): void {
    renderDiff(diffBox, d ? zoneModel(d) : null);
  }

  function autoscroll(d: Drag): boolean {
    const r = d.stageRect;
    if (!r) return false;
    const c = d.client;
    const speed = (p: number, lo: number, hi: number) =>
      (p < lo + EDGE ? -Math.min(1, (lo + EDGE - p) / EDGE) : p > hi - EDGE ? Math.min(1, (p - (hi - EDGE)) / EDGE) : 0) * MAX_SCROLL;
    const vx = speed(c.clientX, r.left, r.right);
    const vy = speed(c.clientY, r.top, r.bottom);
    if (!vx && !vy) return false;
    const x0 = stage.scrollLeft;
    const y0 = stage.scrollTop;
    stage.scrollLeft = x0 + vx;
    stage.scrollTop = y0 + vy;
    if (stage.scrollLeft === x0 && stage.scrollTop === y0) return false;
    rectCache = null;
    return true;
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
    canvas.insertBefore(o, over);
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
      d.groups = [...moving, ...insideGroups].map((g) => floatClone(d, g));
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
    hover = null;
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
    step: (x: number, y: number) => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now: number) => {
        const k = Math.min((now - t0) / ms, 1);
        const e = 1 - Math.pow(1 - k, 3);
        step(from.dx + (to.dx - from.dx) * e, from.dy + (to.dy - from.dy) * e);
        if (k < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  async function settleBack(d: Drag): Promise<void> {
    busy = true;
    renderDiffFor(null);
    over.replaceChildren();
    if (d.target.kind === "node") {
      await tween({ ...d.cur }, { dx: 0, dy: 0 }, 160, (x, y) => {
        for (const g of d.groups) g.setAttribute("transform", `translate(${x} ${y})`);
        d.cur = { dx: x, dy: y };
        drawAttached(d);
      });
    }
    restoreGroups(d);
    busy = false;
    setStatus(statusLine(), "", detail());
    flushExternal();
  }

  async function finish(d: Drag, cancelled: boolean): Promise<void> {
    if (drag !== d) return;
    cancelAnimationFrame(d.raf);
    d.finishing = true;
    drag = null;
    canvas.classList.remove("dragging");
    window.removeEventListener("keydown", d.onKey);
    if (!d.active) {
      d.abort.abort();
      over.replaceChildren();
      if (!cancelled && d.target.kind === "node") select(d.target.id);
      return;
    }
    const z = d.zone;
    if (cancelled || !z || z.kind === "stay" || z.kind === "none") {
      d.abort.abort();
      return settleBack(d);
    }
    const dropAt = performance.now();
    busy = true;
    renderDiffFor(null);
    const cand = "key" in z ? d.cands.get(z.key) : undefined;
    if (!cand && z.kind !== "pin") setStatus("Working out the exact result…", "busy");
    const moved = d.target.kind === "node" ? shapes.get(d.target.id) : undefined;
    if (z.kind === "move" && cand && moved) {
      void tween({ ...d.cur }, { dx: cand.landing.x - moved.x, dy: cand.landing.y - moved.y }, 200, (x, y) => {
        d.cur = { dx: x, dy: y };
        applyFloat(d);
        drawAttached(d);
      });
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
      setStatus(doneText(d.target, z), "done", detail());
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
      plan: [],
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
      stats: { kind: target.kind, firstZoneMs: null, allZonesMs: null, arrivals: [], routeMs: [], frameWork: [] },
      onKey: (e) => {
        if (e.key === "Escape") void finish(d, true);
      },
    };
    window.addEventListener("keydown", d.onKey);
    drag = d;
    stats.current = d;
    canvas.setPointerCapture(ev.pointerId);
    d.plan = target.kind === "node" ? planNode(zoneContext(), target.id, start) : planEnd(zoneContext(), target, start);
    d.zone = { kind: target.kind === "node" ? "stay" : "none" };
    hover = null;
    renderOverlay(d);
    setStatus(statusFor(d.target, d.zone), "busy");
    d.stats.planMs = performance.now() - d.t0;
    startPreview(d);
  }

  function onDown(ev: PointerEvent): void {
    if (busy || drag || !view || ev.button !== 0) return;
    ev.preventDefault();
    const p = toDiagram(ev);
    const end = hitEnd(p);
    if (end) return beginDrag(ev, { kind: "edgeEnd", edge: end.conn.id, end: end.end });
    const s = hitShape(p);
    if (s) beginDrag(ev, { kind: "node", id: s.id });
    else select("");
  }

  function onMove(ev: PointerEvent): void {
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

  function select(id: string): void {
    selected = id;
    emit("select", id);
  }

  function detail(): string {
    return view ? `v${view.version} · ${view.shapes.length} shapes · layout ${view.layoutMs.toFixed(0)} ms` : "";
  }

  function statusLine(): string {
    if (!view) return "Loading…";
    return opts.hint?.() ?? "Drag a box to move it, or drag the end of an arrow to reconnect it";
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
      setStatus(v.error, "err");
      if (!view || v.version > view.version) view = { ...(view ?? v), error: v.error, version: v.version };
      return;
    }
    settleOrder();
    const prev = view;
    if (!prev || (prev.error && !prev.svg) || v.cause === "open" || !outer || !inner) {
      view = v;
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
    orderTarget = p.inner;
    void Promise.all(finished).then(settleOrder);
    setTimeout(settleOrder, 1500);
    finishApply(prev, v);
  }

  function settleOrder(): void {
    const target = orderTarget;
    if (!target || !inner) return;
    const want = Array.from(target.children).map((c) => groups.get(c.getAttribute("class") ?? "") ?? null);
    const present = want.filter((n): n is Element => !!n);
    const cur = Array.from(inner.children).filter((n) => present.includes(n));
    if (cur.some((n, i) => n !== present[i])) for (const n of present) inner.insertBefore(n, inner.querySelector(":scope > mask"));
    for (const n of inner.querySelectorAll("[data-moving]")) delete (n as HTMLElement).dataset["moving"];
  }

  function finishApply(prev: View | null, v: View): void {
    hover = null;
    over.replaceChildren();
    emit("view", v, prev);
    setStatus(statusLine(), "", detail());
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
      setStatus(kind === "undo" ? "Undone" : "Redone", "done", detail());
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
      setStatus(edit.kind === "direction" ? "Layout direction changed" : "Positions cleared", "done", detail());
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

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", () => {
    if (drag) void finish(drag, false);
  });
  canvas.addEventListener("pointercancel", () => {
    if (drag) void finish(drag, true);
  });
  canvas.addEventListener("pointerleave", () => {
    if (!drag) {
      hover = null;
      over.replaceChildren();
    }
  });
  canvas.addEventListener("dblclick", (ev) => {
    if (!view || busy) return;
    const s = hitShape(toDiagram(ev));
    if (s?.pinned) void send({ kind: "unpin", key: s.id });
  });
  window.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if (!(e.metaKey || e.ctrlKey) || (key !== "z" && key !== "y")) return;
    if (/input|textarea/i.test((e.target as HTMLElement | null)?.tagName ?? "")) return;
    e.preventDefault();
    void history(key === "y" || e.shiftKey ? "redo" : "undo");
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
    get scale() {
      return scale;
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
    statusLine,
  };
}
