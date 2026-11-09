import { esc } from "../geometry";
import type { PendingChange, View } from "../types";
import { highlight, isPositionLine } from "./highlight";
import { store } from "./store";

const OPEN_KEY = "d2sq.code.open";
const WIDTH_KEY = "d2sq.code.w";
const HEIGHT_KEY = "d2sq.code.h";
const DEBOUNCE_MS = 450;
const SHEET = "(max-width: 700px)";

export interface CodePanel {
  readonly open: boolean;
  setOpen(open: boolean): void;
  toggle(): void;
  setSource(view: View): void;
  setPending(change: PendingChange | null): void;
  setError(message: string | null): void;
  extent(): { right: number; bottom: number };
}

export interface CodeOptions {
  readOnly: boolean;
  onEdit: (text: string) => void;
  onLayout: (animate: boolean) => void;
  onToggle: (open: boolean) => void;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export function mountCode(root: HTMLElement, opts: CodeOptions): CodePanel {
  const $ = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const scroller = $("code-scroll");
  const lines = $("code-lines");
  const input = $<HTMLTextAreaElement>("code-input");
  const errorBar = $("code-error");
  const note = $("code-note");
  const grip = $("code-resize");
  const sheet = matchMedia(SHEET);

  let open = false;
  let text = "";
  let pending: PendingChange | null = null;
  let error: string | null = null;
  let changed = new Set<number>();
  let editing = 0;
  let fade = 0;

  input.readOnly = opts.readOnly;
  root.classList.toggle("readonly", opts.readOnly);

  const storedWidth = Number(store.get(WIDTH_KEY));
  const storedHeight = Number(store.get(HEIGHT_KEY));
  let width = storedWidth > 0 ? storedWidth : 440;
  let height = storedHeight > 0 ? storedHeight : Math.round(window.innerHeight * 0.4);

  const maxWidth = (): number => Math.min(760, window.innerWidth * 0.6);
  const maxHeight = (): number => window.innerHeight * 0.7;

  function applySize(): void {
    width = clamp(width, 300, maxWidth());
    height = clamp(height, 180, maxHeight());
    document.body.style.setProperty("--code-w", `${width}px`);
    document.body.style.setProperty("--code-h", `${height}px`);
  }

  function extent(): { right: number; bottom: number } {
    if (!open) return { right: 0, bottom: 0 };
    return sheet.matches ? { right: 0, bottom: height + 16 } : { right: width + 24, bottom: 0 };
  }

  function row(n: number, line: string, cls = ""): string {
    return `<div class="ln${cls}"><span class="n">${n || ""}</span><span class="t">${highlight(line) || " "}</span></div>`;
  }

  function render(): void {
    root.classList.toggle("pending", pending !== null);
    note.textContent = pending ? "Pending change" : "";
    if (pending) {
      if (pending.working) {
        lines.innerHTML = `<div class="ln note"><span class="n"></span><span class="t">Working out the exact result…</span></div>`;
        return;
      }
      const rows = (pending.lines ?? []).map((l) => {
        if (l.op === "…") return `<div class="ln gap"><span class="n"></span><span class="t">⋯</span></div>`;
        const cls = l.op === "+" ? " add" : l.op === "-" ? " del" : "";
        const mark = l.op === "+" || l.op === "-" ? l.op : "";
        return `<div class="ln${cls}${isPositionLine(l.text ?? "") ? " pos" : ""}"><span class="n">${mark}</span><span class="t">${highlight(l.text ?? "") || " "}</span></div>`;
      });
      if (pending.saved)
        rows.push(
          `<div class="ln note"><span class="n"></span><span class="t">${esc(`Also saves ${pending.saved} position lines so nothing else moves`)}</span></div>`,
        );
      lines.innerHTML = rows.join("");
      return;
    }
    const source = text.split("\n");
    const errorLine = error ? Number(/:(\d+):\d+/.exec(error)?.[1] ?? 0) : 0;
    lines.innerHTML = source
      .map((line, i) => {
        if (i === source.length - 1 && line === "" && i > 0) return row(0, "");
        const cls = (changed.has(i + 1) ? " hl" : "") + (isPositionLine(line) ? " pos" : "") + (errorLine === i + 1 ? " err" : "");
        return row(i + 1, line, cls);
      })
      .join("");
  }

  function setOpen(next: boolean, animate = true): void {
    open = next;
    root.classList.toggle("open", next);
    root.setAttribute("aria-hidden", String(!next));
    root.toggleAttribute("inert", !next);
    store.set(OPEN_KEY, next ? "1" : "0");
    opts.onToggle(next);
    opts.onLayout(animate);
  }

  function setSource(view: View): void {
    const incoming = view.source;
    if (!editing && incoming.trimEnd() !== input.value.trimEnd()) input.value = incoming;
    text = input.value;
    window.clearTimeout(fade);
    changed = new Set(open && ["commit", "undo", "redo"].includes(view.cause) ? (view.changed ?? []) : []);
    render();
    if (changed.size > 0) {
      const first = lines.querySelector<HTMLElement>(".ln.hl");
      if (first) scroller.scrollTop = Math.max(0, first.offsetTop - scroller.clientHeight / 2);
      fade = window.setTimeout(() => {
        changed = new Set();
        render();
      }, 2600);
    }
  }

  function setError(message: string | null): void {
    error = message;
    errorBar.hidden = message === null;
    errorBar.textContent = message ?? "";
    if (!pending) render();
  }

  input.addEventListener("input", () => {
    text = input.value;
    changed = new Set();
    render();
    window.clearTimeout(editing);
    editing = window.setTimeout(() => {
      editing = 0;
      opts.onEdit(input.value);
    }, DEBOUNCE_MS);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") input.blur();
    if (e.key === "Tab" && !e.shiftKey && !opts.readOnly) {
      e.preventDefault();
      input.setRangeText("  ", input.selectionStart, input.selectionEnd, "end");
      input.dispatchEvent(new Event("input"));
    }
  });

  let resizing = false;
  grip.addEventListener("pointerdown", (e) => {
    resizing = true;
    grip.setPointerCapture(e.pointerId);
    root.classList.add("resizing");
  });
  grip.addEventListener("pointermove", (e) => {
    if (!resizing) return;
    if (sheet.matches) height = window.innerHeight - e.clientY - 8;
    else width = window.innerWidth - e.clientX - 12;
    applySize();
    opts.onLayout(false);
  });
  const stopResize = () => {
    if (!resizing) return;
    resizing = false;
    root.classList.remove("resizing");
    store.set(WIDTH_KEY, String(Math.round(width)));
    store.set(HEIGHT_KEY, String(Math.round(height)));
  };
  grip.addEventListener("pointerup", stopResize);
  grip.addEventListener("pointercancel", stopResize);
  grip.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? 24 : e.key === "ArrowRight" || e.key === "ArrowDown" ? -24 : 0;
    if (!step) return;
    e.preventDefault();
    if (sheet.matches) height += step;
    else width += step;
    applySize();
    opts.onLayout(false);
  });
  window.addEventListener("resize", () => {
    applySize();
    if (open) opts.onLayout(false);
  });
  sheet.addEventListener("change", () => {
    if (open) opts.onLayout(false);
  });

  $("code-close").addEventListener("click", () => setOpen(false));
  applySize();
  const wasOpen = store.get(OPEN_KEY) === "1";
  root.classList.toggle("open", wasOpen);
  root.setAttribute("aria-hidden", String(!wasOpen));
  root.toggleAttribute("inert", !wasOpen);
  open = wasOpen;

  return {
    get open() {
      return open;
    },
    setOpen: (next) => setOpen(next),
    toggle: () => setOpen(!open),
    setSource,
    setPending(change) {
      pending = change;
      render();
    },
    setError,
    extent,
  };
}
