import { esc } from "../geometry";

const KEYWORDS = new Set([
  "shape",
  "style",
  "direction",
  "label",
  "icon",
  "tooltip",
  "link",
  "near",
  "class",
  "classes",
  "vars",
  "layers",
  "scenarios",
  "steps",
  "grid-rows",
  "grid-columns",
  "constraint",
  "top",
  "left",
  "width",
  "height",
  "fill",
  "stroke",
  "opacity",
  "font-size",
  "border-radius",
  "d2-config",
  "layout-engine",
  "theme-id",
]);

const TOKEN =
  /(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(<->|<-|->|--)|([A-Za-z_][\w-]*(?:\.[A-Za-z_*][\w-]*)*)(?=\s*:)|(\b\d+(?:\.\d+)?\b)|([{}[\]|])/g;

export const isPositionLine = (line: string): boolean => /^\s*(top|left|width|height)\s*:/.test(line);

export function highlight(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    out += esc(line.slice(last, at));
    const text = esc(m[0]);
    if (m[1] !== undefined) out += `<span class="tk-comment">${text}</span>`;
    else if (m[2] !== undefined) out += `<span class="tk-string">${text}</span>`;
    else if (m[3] !== undefined) out += `<span class="tk-arrow">${text}</span>`;
    else if (m[4] !== undefined) {
      const word = m[4].slice(m[4].lastIndexOf(".") + 1);
      out += `<span class="${KEYWORDS.has(word) ? "tk-keyword" : "tk-key"}">${text}</span>`;
    } else if (m[5] !== undefined) out += `<span class="tk-number">${text}</span>`;
    else out += `<span class="tk-punct">${text}</span>`;
    last = at + m[0].length;
  }
  return out + esc(line.slice(last));
}
