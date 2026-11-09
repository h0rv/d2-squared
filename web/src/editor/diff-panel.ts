import { esc } from "../geometry";
import type { DiffLine } from "../types";

export interface DiffModel {
  title: string;
  pending?: boolean;
  lines?: DiffLine[];
  pins?: number;
}

const MAX_LINES = 8;

export function renderDiff(box: HTMLElement, model: DiffModel | null): void {
  if (!model) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const shown = (model.lines ?? []).filter((l) => (l.op === "+" || l.op === "-") && (l.text ?? "").trim());
  const rows = shown
    .slice(0, MAX_LINES)
    .map((l) => `<div class="l ${l.op === "+" ? "add" : "del"}"><i>${l.op}</i><span>${esc(l.text ?? "")}</span></div>`)
    .join("");
  const more = shown.length > MAX_LINES ? `<div class="l gap"><i></i><span>…</span></div>` : "";
  const pins = model.pins ? `<div class="note">Also saves ${model.pins} position lines so nothing else moves</div>` : "";
  const body = model.pending ? `<div class="note">Working out the exact result…</div>` : rows + more;
  box.innerHTML = `<div class="title">This drop will change the file (${esc(model.title)}):</div>${body}${pins}`;
}
