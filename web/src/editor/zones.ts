import { contains, depth, editId, parentOf, rectDist, within } from "../geometry";
import type { Candidate, Edit, PendingChange, Point, Shape, Target } from "../types";

export const PLACING_NEEDS_TALA = "Placing and resizing need the TALA layout engine";

export type Zone =
  | { kind: "stay" }
  | { kind: "blocked" }
  | { kind: "none" }
  | { kind: "pin"; left: number; top: number; edit: Edit }
  | { kind: "move"; to: string; key: string; edit: Edit }
  | { kind: "reconnect"; shape: string; row: number; to: string; key: string; edit: Edit; end: "src" | "dst" };

export interface ZoneContext {
  view: { shapes: Shape[] };
  shapes: Map<string, Shape>;
  scale: number;
  enabled: ReadonlySet<string>;
  engine: string;
}

export const isContainer = (view: { shapes: Shape[] }, id: string): boolean => view.shapes.some((s) => parentOf(s.id) === id);

export function pinZone(me: Shape, cur: { dx: number; dy: number }, id: string): Zone {
  const left = Math.round(me.x + cur.dx);
  const top = Math.round(me.y + cur.dy);
  return { kind: "pin", left, top, edit: { kind: "pin", key: id, left, top } };
}

export interface NodePick {
  id: string;
  ptr: Point;
  cur: { dx: number; dy: number };
  moved: boolean;
  alt: boolean;
}

export function pickNode(ctx: ZoneContext, d: NodePick): Zone {
  const me = ctx.shapes.get(d.id);
  if (!me) return { kind: "stay" };
  const near = Math.hypot(d.cur.dx, d.cur.dy);
  if (!d.moved || near < 18 / ctx.scale) return { kind: "stay" };
  const needsTala = ctx.engine !== "tala";
  const pinOr = (): Zone => (ctx.enabled.has("pin") ? pinZone(me, d.cur, d.id) : { kind: needsTala ? "blocked" : "stay" });
  if (d.alt) return pinOr();
  if (!ctx.enabled.has("reparent")) return pinZone(me, d.cur, d.id);
  const margin = 18 / ctx.scale;
  let best: Shape | null = null;
  let bestScore = Infinity;
  for (const s of ctx.view.shapes) {
    if (within(s.id, d.id) || !isContainer(ctx.view, s.id)) continue;
    const dist = rectDist(s, d.ptr);
    if (dist > margin) continue;
    const score = dist * 1000 - depth(s.id);
    if (score < bestScore) {
      best = s;
      bestScore = score;
    }
  }
  const parent = parentOf(d.id);
  const to = best ? best.id : "";
  if (best && best.id === parent) return pinOr();
  if (!best && parent === "") return pinOr();
  const edit: Edit = { kind: "move", key: d.id, to };
  return { kind: "move", to, key: editId(edit), edit };
}

export interface EndPick {
  edge: string;
  end: "src" | "dst";
  ptr: Point;
  moved: boolean;
  fixedShape: string;
}

export function pickEnd(ctx: ZoneContext, d: EndPick): Zone {
  if (!d.moved) return { kind: "none" };
  const margin = 14 / ctx.scale;
  let best: Shape | null = null;
  let bestDist = margin;
  for (const s of ctx.view.shapes) {
    if (isContainer(ctx.view, s.id) || s.id === d.fixedShape) continue;
    const dist = rectDist(s, d.ptr);
    if (dist <= bestDist) {
      best = s;
      bestDist = dist;
    }
  }
  if (!best) return { kind: "none" };
  let row = -1;
  let to = best.id;
  const cols = best.cols ?? [];
  if (cols.length > 0) {
    const rh = best.height / (cols.length + 1);
    const idx = Math.floor((d.ptr.y - best.y) / rh) - 1;
    row = idx >= 0 && idx < cols.length && contains(best, d.ptr) ? idx : Math.max(best.pk, 0);
    to = `${best.id}.${cols[row] ?? ""}`;
  }
  const edit: Edit = { kind: "reconnect", key: d.edge, end: d.end, to };
  return {
    kind: "reconnect",
    shape: best.id,
    row,
    to,
    key: editId(edit),
    edit,
    end: d.end,
  };
}

export type Namer = (id: string) => string;

export function tipFor(target: Target, zone: Zone, name: Namer): string {
  if (zone.kind === "none") return target.kind === "edgeEnd" ? "Drop on a box to connect" : "";
  if (zone.kind === "blocked") return PLACING_NEEDS_TALA;
  if (zone.kind === "pin") return "Place here";
  if (zone.kind === "move") return zone.to ? `Move into ${name(zone.to)}` : "Move to the top level";
  if (zone.kind === "reconnect") {
    const column = zone.row >= 0 ? ` · ${zone.to.slice(zone.to.lastIndexOf(".") + 1)}` : "";
    return `Connect ${zone.end === "dst" ? "to" : "from"} ${name(zone.shape)}${column}`;
  }
  return "";
}

export function doneText(target: Target, zone: Zone, name: Namer): string {
  const who = target.kind === "node" ? name(target.id) : "Arrow";
  if (zone.kind === "move") return `Moved ${who} ${zone.to ? "into " + name(zone.to) : "to the top level"}`;
  if (zone.kind === "pin") return `Placed ${who}`;
  if (zone.kind === "reconnect") return `Connected ${zone.end === "dst" ? "to" : "from"} ${name(zone.shape)}`;
  return "";
}

export function pendingFor(target: Target, zone: Zone | null, cand: Candidate | undefined, name: Namer): PendingChange | null {
  if (!zone || zone.kind === "stay" || zone.kind === "none") return null;
  const title = tipFor(target, zone, name);
  if (zone.kind === "blocked") return { title };
  if (zone.kind === "pin") {
    return {
      title,
      lines: [
        { op: "+", text: `left: ${zone.left}` },
        { op: "+", text: `top: ${zone.top}` },
      ],
    };
  }
  if (!cand) return { title, working: true };
  return { title, lines: cand.diff, saved: cand.pinLines };
}
