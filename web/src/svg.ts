export const SVG_NS = "http://www.w3.org/2000/svg";

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

export function parseSvg(text: string): { outer: SVGSVGElement; inner: SVGSVGElement } {
  const tpl = document.createElement("template");
  tpl.innerHTML = text;
  const outer = tpl.content.firstElementChild as SVGSVGElement;
  const inner = outer.querySelector(":scope > svg") as SVGSVGElement;
  return { outer, inner };
}
