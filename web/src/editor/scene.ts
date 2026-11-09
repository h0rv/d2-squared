import { depth, parentOf } from "../geometry";
import { svgEl } from "../svg";
import type { Point, View } from "../types";

const EASE = "cubic-bezier(.2,.8,.2,1)";
const TWEEN_MS = 260;

export interface Piece {
  id: string;
  el: SVGGElement;
  svg: string;
  layer: SVGGElement;
  rank: number;
}

export function mountScene(scene: SVGSVGElement) {
  const defsEl = scene.querySelector("defs")!;
  const styleEl = scene.querySelector("style")!;
  const groupsLayer = scene.querySelector<SVGGElement>(".l-groups")!;
  const connsLayer = scene.querySelector<SVGGElement>(".l-conns")!;
  const shapesLayer = scene.querySelector<SVGGElement>(".l-shapes")!;
  const dragLayer = scene.querySelector<SVGGElement>(".l-drag")!;
  const pieces = new Map<string, Piece>();

  function settle(layer: SVGGElement): void {
    const els = Array.from(layer.children);
    const rank = (el: Element) => pieces.get(el.getAttribute("data-id") ?? "")?.rank ?? 0;
    const sorted = [...els].sort((a, b) => rank(a) - rank(b));
    if (sorted.some((el, i) => el !== els[i])) layer.append(...sorted);
  }

  function settleAll(): void {
    for (const layer of [groupsLayer, connsLayer, shapesLayer]) settle(layer);
  }

  function dock(p: Piece): void {
    p.el.removeAttribute("transform");
    p.el.classList.remove("lift");
    p.layer.appendChild(p.el);
  }

  function clear(): void {
    for (const p of pieces.values()) p.el.remove();
    pieces.clear();
    dragLayer.replaceChildren();
  }

  function fade(node: Element, from: number, to: number): void {
    node.animate?.([{ opacity: from }, { opacity: to }], { duration: TWEEN_MS, easing: "ease-out" });
  }

  function ghost(p: Piece): void {
    const clone = p.el.cloneNode(true) as SVGGElement;
    clone.removeAttribute("data-id");
    dragLayer.appendChild(clone);
    const gone = () => clone.remove();
    const a = clone.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: TWEEN_MS, easing: "ease-out" });
    if (a) a.finished.then(gone, gone);
    else gone();
  }

  function glide(p: Piece, from: Point): void {
    if (!p.el.animate) return;
    dragLayer.appendChild(p.el);
    const a = p.el.animate([{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: "translate(0px, 0px)" }], {
      duration: TWEEN_MS,
      easing: EASE,
    });
    const home = () => {
      if (pieces.get(p.id) === p && p.el.parentNode === dragLayer) {
        p.layer.appendChild(p.el);
        settle(p.layer);
      }
    };
    a.finished.then(home, home);
  }

  function sync(v: View, prev: View | null, floating: Map<string, { dx: number; dy: number }>): void {
    const { css, defs } = v.scene;
    if (styleEl.textContent !== css) styleEl.textContent = css;
    if (defsEl.dataset["defs"] !== defs) {
      defsEl.innerHTML = defs;
      defsEl.dataset["defs"] = defs;
    }
    for (const p of pieces.values()) if (p.el.parentNode !== p.layer) p.layer.appendChild(p.el);
    const parents = new Set(v.shapes.map((s) => parentOf(s.id)));
    const groups = v.scene.shapes.filter((p) => parents.has(p.id)).sort((a, b) => depth(a.id) - depth(b.id));
    const leaves = v.scene.shapes.filter((p) => !parents.has(p.id));
    const wanted = [
      ...groups.map((p) => ({ ...p, layer: groupsLayer })),
      ...v.scene.connections.map((p) => ({ ...p, layer: connsLayer })),
      ...leaves.map((p) => ({ ...p, layer: shapesLayer })),
    ];
    const before = new Map(prev?.shapes.map((s) => [s.id, s]));
    const after = new Map(v.shapes.map((s) => [s.id, s]));
    const keep = new Set(wanted.map((w) => w.id));
    for (const [id, p] of pieces) {
      if (keep.has(id)) continue;
      ghost(p);
      p.el.remove();
      pieces.delete(id);
    }
    wanted.forEach((w, rank) => {
      let p = pieces.get(w.id);
      if (!p) {
        const el = svgEl("g", { "data-id": w.id });
        el.innerHTML = w.svg;
        p = { id: w.id, el, svg: w.svg, layer: w.layer, rank };
        pieces.set(w.id, p);
        w.layer.appendChild(el);
        if (prev) fade(el, 0, 1);
        return;
      }
      p.rank = rank;
      if (p.layer !== w.layer) {
        p.layer = w.layer;
        w.layer.appendChild(p.el);
      }
      if (p.svg === w.svg) return;
      const was = before.get(w.id);
      const now = after.get(w.id);
      const f = floating.get(w.id) ?? { dx: 0, dy: 0 };
      const slid = was && now && was.width === now.width && was.height === now.height;
      if (!slid) ghost(p);
      p.el.innerHTML = w.svg;
      p.svg = w.svg;
      if (!slid) return fade(p.el, 0, 1);
      const off = { x: was.x + f.dx - now.x, y: was.y + f.dy - now.y };
      if (Math.abs(off.x) > 0.5 || Math.abs(off.y) > 0.5) glide(p, off);
    });
    settleAll();
  }

  return { pieces, dragLayer, dock, settleAll, sync, clear };
}
