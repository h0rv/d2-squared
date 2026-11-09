import type { Engine } from "../engine/engine";
import type { Toasts } from "./toast";
import { store } from "./store";

const BASE_SIZE = 13;
const MIN_SIZE = 10;
const PAD = 24;
const KEY = "d2sq.text.unicode";

export const unicodePreferred = (): boolean => store.get(KEY) !== "0";

export interface TextView {
  readonly active: boolean;
  setActive(active: boolean): void;
  refresh(): void;
}

export function mountTextView(root: HTMLElement, engine: Engine, toasts: Toasts): TextView {
  const $ = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const out = $("text-out");
  const scroll = $("text-scroll");
  const note = $("text-note");
  const unicode = $("text-unicode");
  const ascii = $("text-ascii");
  let active = false;
  let seq = 0;
  let text = "";

  function fit(): void {
    root.style.removeProperty("--text-size");
    if (!active || root.classList.contains("failed")) return;
    const ratio = Math.min(
      (scroll.clientWidth - 2 * PAD) / (out.offsetWidth - 2 * PAD),
      (scroll.clientHeight - 2 * PAD) / (out.offsetHeight - 2 * PAD),
    );
    if (ratio < 1) root.style.setProperty("--text-size", `${Math.max(MIN_SIZE, Math.floor(BASE_SIZE * ratio))}px`);
  }

  function paintCharset(): void {
    const on = unicodePreferred();
    unicode.setAttribute("aria-checked", String(on));
    ascii.setAttribute("aria-checked", String(!on));
  }

  function refresh(): void {
    if (!active) return;
    const mine = ++seq;
    engine.text(unicodePreferred()).then(
      (res) => {
        if (mine !== seq) return;
        text = res.text;
        out.textContent = res.text;
        note.textContent = res.note;
        root.classList.remove("failed");
        fit();
      },
      (err: unknown) => {
        if (mine !== seq) return;
        text = "";
        out.textContent = err instanceof Error ? err.message : "This diagram can't be shown as text.";
        note.textContent = "";
        root.classList.add("failed");
        fit();
      },
    );
  }

  async function copy(): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toasts.show("Copied");
      return;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      if (ok) toasts.show("Copied");
      else
        toasts.show("Couldn't copy. Select the text and copy it yourself.", {
          error: true,
        });
    }
  }

  const choose = (on: boolean): void => {
    store.set(KEY, on ? "1" : "0");
    paintCharset();
    refresh();
  };
  unicode.onclick = () => choose(true);
  ascii.onclick = () => choose(false);
  $("text-copy").onclick = () => void copy();
  paintCharset();
  new ResizeObserver(fit).observe(scroll);

  return {
    get active() {
      return active;
    },
    setActive(next) {
      active = next;
      root.hidden = !next;
      document.body.classList.toggle("text-mode", next);
      if (next) refresh();
    },
    refresh,
  };
}
