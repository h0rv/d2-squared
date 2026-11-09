import type { Edit, Point, Shape } from "./types";

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const parentOf = (id: string): string => (id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : "");

export const within = (id: string, root: string): boolean => root !== "" && (id === root || id.startsWith(root + "."));

export const depth = (id: string): number => id.split(".").length;

export const nameOf = (id: string): string => id.slice(id.lastIndexOf(".") + 1);

export const editId = (e: Edit): string => `${e.kind}|${e.key}|${e.end ?? ""}|${e.to ?? ""}|${e.left ?? 0},${e.top ?? 0}`;

export const contains = (s: Shape, p: Point, margin = 0): boolean =>
  p.x >= s.x - margin && p.x <= s.x + s.width + margin && p.y >= s.y - margin && p.y <= s.y + s.height + margin;

export const landsIn = (landing: Shape, target: Shape | undefined): boolean =>
  !target ||
  (landing.x >= target.x &&
    landing.y >= target.y &&
    landing.x + landing.width <= target.x + target.width &&
    landing.y + landing.height <= target.y + target.height);

export const rectDist = (s: Shape, p: Point): number =>
  Math.hypot(Math.max(s.x - p.x, p.x - (s.x + s.width), 0), Math.max(s.y - p.y, p.y - (s.y + s.height), 0));

export function midpoint(points: [number, number][]): [number, number] {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  let left = total / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (left <= len && len > 0) return [a[0] + ((b[0] - a[0]) * left) / len, a[1] + ((b[1] - a[1]) * left) / len];
    left -= len;
  }
  return points[points.length - 1] ?? [0, 0];
}

const CORNER = 10;

export function pathD(points: [number, number][], hasStartMarker: boolean, hasEndMarker: boolean): string {
  const pts = points.map((p): [number, number] => [p[0], p[1]]);
  const trim = (a: [number, number], b: [number, number], by: number): [number, number] => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return [a[0] + (dx / len) * by, a[1] + (dy / len) * by];
  };
  if (pts.length >= 2) {
    pts[0] = trim(pts[0]!, pts[1]!, hasStartMarker ? 4 : 2);
    const n = pts.length;
    pts[n - 1] = trim(pts[n - 1]!, pts[n - 2]!, hasEndMarker ? 4 : 2);
  }
  if (pts.length < 3) return pts.map((p, i) => `${i ? "L" : "M"} ${p[0]} ${p[1]}`).join(" ");
  let d = `M ${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const v = pts[i]!;
    const b = pts[i + 1]!;
    const li = Math.hypot(v[0] - a[0], v[1] - a[1]) || 1;
    const lo = Math.hypot(b[0] - v[0], b[1] - v[1]) || 1;
    const r = Math.min(CORNER, li / 2, lo / 2);
    d += ` L ${v[0] - ((v[0] - a[0]) / li) * r} ${v[1] - ((v[1] - a[1]) / li) * r} S ${v[0]} ${v[1]} ${v[0] + ((b[0] - v[0]) / lo) * r} ${v[1] + ((b[1] - v[1]) / lo) * r}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L ${last[0]} ${last[1]}`;
}
