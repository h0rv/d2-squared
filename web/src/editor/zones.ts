import { contains, depth, editId, nameOf, parentOf, rectDist, within } from "../geometry";
import type { Edit, Point, Shape, Target, View } from "../types";

export type Zone =
  | { kind: "stay" }
  | { kind: "none" }
  | { kind: "pin"; left: number; top: number; edit: Edit }
  | { kind: "move"; to: string; key: string; edit: Edit; title: string }
  | { kind: "reconnect"; shape: string; row: number; to: string; key: string; edit: Edit; title: string };

export interface PlanItem {
  key: string;
  edit: Edit;
  box: Pick<Shape, "x" | "y" | "width" | "height">;
  shape?: string;
}

export interface ZoneContext {
  view: View;
  shapes: Map<string, Shape>;
  scale: number;
  enabled: Set<string>;
  canvasBox: { x: number; y: number; w: number; h: number };
}

const MAX_MOVE = 32;
const MAX_RECONNECT = 12;

export const isContainer = (view: View, id: string): boolean => view.shapes.some((s) => parentOf(s.id) === id);

export function planNode(ctx: ZoneContext, id: string, start: Point): PlanItem[] {
  const parent = parentOf(id);
  const plan: PlanItem[] = [];
  const add = (to: string, box: PlanItem["box"]) => {
    const edit: Edit = { kind: "move", key: id, to };
    plan.push({ key: editId(edit), edit, box });
  };
  let limit = MAX_MOVE;
  if (parent !== "") {
    const c = ctx.canvasBox;
    add("", { x: c.x, y: c.y, width: c.w, height: c.h });
    limit--;
  }
  const near = ctx.view.shapes
    .filter((c) => !within(c.id, id) && c.id !== parent && isContainer(ctx.view, c.id))
    .sort((a, b) => rectDist(a, start) - rectDist(b, start))
    .slice(0, limit);
  for (const c of near) add(c.id, c);
  return plan;
}

export function planEnd(ctx: ZoneContext, target: Extract<Target, { kind: "edgeEnd" }>, start: Point): PlanItem[] {
  const conn = ctx.view.conns.find((x) => x.id === target.edge);
  if (!conn) return [];
  const current = target.end === "dst" ? conn.dst : conn.src;
  const other = target.end === "dst" ? conn.src : conn.dst;
  return ctx.view.shapes
    .filter((s) => s.id !== current && s.id !== other && !isContainer(ctx.view, s.id))
    .sort((a, b) => rectDist(a, start) - rectDist(b, start))
    .slice(0, MAX_RECONNECT)
    .map((s) => {
      const first = s.cols?.[Math.max(s.pk, 0)];
      const to = first !== undefined ? `${s.id}.${first}` : s.id;
      const edit: Edit = { kind: "reconnect", key: target.edge, end: target.end, to };
      return { key: editId(edit), edit, shape: s.id, box: s };
    });
}

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
  return { kind: "move", to, key: editId(edit), edit, title: to ? `move into ${to}` : "move to top level" };
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
    title: `${d.end === "dst" ? "point to" : "start from"} ${to}`,
  };
}

export function statusFor(target: Target, zone: Zone | null): string {
  const name = target.kind === "node" ? nameOf(target.id) : "this arrow";
  if (!zone || zone.kind === "stay") return `Release to put ${name} back`;
  if (zone.kind === "none") return "Drag the end onto a box to reconnect it";
  if (zone.kind === "pin") return `Release to place ${name} here`;
  if (zone.kind === "move") return `Release to move ${name} ${zone.to ? "into " + zone.to : "to the top level"}`;
  return `Release to ${zone.title.replace("point to", "point " + name + " at").replace("start from", "start " + name + " from")}`;
}

export function doneText(target: Target, zone: Zone): string {
  const who = target.kind === "node" ? nameOf(target.id) : "Arrow";
  if (zone.kind === "move") return `Moved ${who} ${zone.to ? "into " + zone.to : "to the top level"}`;
  if (zone.kind === "pin") return `Placed ${who}`;
  if (zone.kind === "reconnect")
    return zone.title.replace("point to", "Arrow now points at").replace("start from", "Arrow now starts from");
  return "";
}
