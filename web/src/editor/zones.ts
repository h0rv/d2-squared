import { contains, depth, editId, parentOf, rectDist, within } from "../geometry";
import type { Edit, Point, Shape, Target, View } from "../types";

export type Zone =
  | { kind: "stay" }
  | { kind: "none" }
  | { kind: "pin"; left: number; top: number; edit: Edit }
  | { kind: "move"; to: string; key: string; edit: Edit }
  | { kind: "reconnect"; shape: string; row: number; to: string; key: string; edit: Edit; end: "src" | "dst" };

export interface ZoneContext {
  view: View;
  shapes: Map<string, Shape>;
  scale: number;
  enabled: Set<string>;
}

export const isContainer = (view: View, id: string): boolean => view.shapes.some((s) => parentOf(s.id) === id);

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
  const pinOr = (): Zone => (ctx.enabled.has("pin") ? pinZone(me, d.cur, d.id) : { kind: "stay" });
  if (d.alt && ctx.enabled.has("pin")) return pinZone(me, d.cur, d.id);
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
  if (zone.kind === "reconnect") return `Arrow now ${zone.end === "dst" ? "points at" : "starts from"} ${name(zone.shape)}`;
  return "";
}
