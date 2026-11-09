import { contains, depth } from "../geometry";
import type { Conn, Point, Shape, View } from "../types";

const FAN_PX = 16;
const FAN_HIT_PX = 9;
const END_HIT_PX = 14;
const END_HIT_TOUCH_PX = 22;
const ARROW_HIT_PX = 9;
const ARROW_HIT_TOUCH_PX = 18;

export interface EndSlot {
  conn: Conn;
  end: "src" | "dst";
  pt: [number, number];
  next: [number, number];
  at: Point;
  siblings: number;
  key: string;
}

export interface HitContext {
  view: View;
  scale: number;
  reconnect: boolean;
  armed: string;
}

function segmentDist(p: Point, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const k = len === 0 ? 0 : Math.min(Math.max(((p.x - a[0]) * dx + (p.y - a[1]) * dy) / len, 0), 1);
  return Math.hypot(p.x - (a[0] + k * dx), p.y - (a[1] + k * dy));
}

export function createHits(context: () => HitContext) {
  let cache: { version: number; scale: number; slots: EndSlot[] } | null = null;

  function hitShape(p: Point): Shape | null {
    let best: Shape | null = null;
    for (const s of context().view.shapes) {
      if (!contains(s, p)) continue;
      if (!best || depth(s.id) > depth(best.id) || (depth(s.id) === depth(best.id) && s.width * s.height < best.width * best.height))
        best = s;
    }
    return best;
  }

  function endSlots(): EndSlot[] {
    const { view, scale } = context();
    if (cache && cache.version === view.version && cache.scale === scale) return cache.slots;
    const byKey = new Map<string, EndSlot[]>();
    for (const conn of view.conns) {
      for (const end of ["src", "dst"] as const) {
        const route = end === "src" ? conn.route : [...conn.route].reverse();
        const pt = route[0];
        const next = route[1];
        if (!pt || !next) continue;
        const key = `${end === "src" ? conn.src : conn.dst}|${Math.round(pt[0] / 4)}|${Math.round(pt[1] / 4)}`;
        byKey.set(key, [...(byKey.get(key) ?? []), { conn, end, pt, next, at: { x: pt[0], y: pt[1] }, siblings: 1, key }]);
      }
    }
    const slots: EndSlot[] = [];
    for (const group of byKey.values()) {
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
    cache = { version: view.version, scale, slots };
    return slots;
  }

  function hitEnd(p: Point, touch = false): EndSlot | null {
    const { scale, reconnect, armed } = context();
    if (!reconnect) return null;
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

  function nearConn(p: Point, touch = false): Conn | null {
    const { view, scale, reconnect } = context();
    if (!reconnect) return null;
    let best: Conn | null = null;
    let bestDist = (touch ? ARROW_HIT_TOUCH_PX : ARROW_HIT_PX) / scale;
    for (const conn of view.conns) {
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

  return { hitShape, endSlots, hitEnd, nearConn };
}
