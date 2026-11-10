import { catalog } from "../app/catalog";
import { download } from "../app/export";
import type { Engine } from "../engine/engine";
import { store } from "./store";
import type { Toasts } from "./toast";

const BASE_SIZE = 13;
const MIN_SIZE = 10;
const PAD = 24;
const KEY = "d2sq.text.charset";

export interface TextModal {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  refresh(): void;
}

export function mountTextModal(root: HTMLElement, engine: Engine, toasts: Toasts, name: () => string): TextModal {
  const $ = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const view = $("text-view");
  const out = $("text-out");
  const scroll = $("text-scroll");
  const note = $("text-note");
  const switcher = $("text-charset");
  let opened = false;
  let seq = 0;
  let text = "";

  const charset = (): string => {
    const ids = catalog().charsets.map((c) => c.id);
    const saved = store.get(KEY);
    return saved && ids.includes(saved) ? saved : (ids[0] ?? "unicode");
  };

  function fit(): void {
    view.style.removeProperty("--text-size");
    if (!opened || view.classList.contains("failed")) return;
    const ratio = Math.min(
      (scroll.clientWidth - 2 * PAD) / (out.offsetWidth - 2 * PAD),
      (scroll.clientHeight - 2 * PAD) / (out.offsetHeight - 2 * PAD),
    );
    if (ratio < 1) view.style.setProperty("--text-size", `${Math.max(MIN_SIZE, Math.floor(BASE_SIZE * ratio))}px`);
  }

  function paintCharset(): void {
    for (const button of switcher.querySelectorAll("button"))
      button.setAttribute("aria-checked", String(button.dataset["charset"] === charset()));
  }

  function refresh(): void {
    if (!opened) return;
    const mine = ++seq;
    engine.text(charset() === "unicode").then(
      (res) => {
        if (mine !== seq) return;
        text = res.text;
        out.textContent = res.text;
        note.textContent = res.note;
        view.classList.remove("failed");
        fit();
      },
      (err: unknown) => {
        if (mine !== seq) return;
        text = "";
        out.textContent = err instanceof Error ? err.message : "This diagram can't be shown as text.";
        note.textContent = "";
        view.classList.add("failed");
        fit();
      },
    );
  }

  async function copy(): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toasts.show("Copied");
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
      else toasts.show("Couldn't copy. Select the text and copy it yourself.", { error: true });
    }
  }

  function close(): void {
    if (!opened) return;
    opened = false;
    root.hidden = true;
  }

  switcher.replaceChildren(
    ...catalog().charsets.map((c) => {
      const button = document.createElement("button");
      button.className = "seg-btn";
      button.setAttribute("role", "radio");
      button.dataset["charset"] = c.id;
      button.textContent = c.name;
      button.onclick = () => {
        store.set(KEY, c.id);
        paintCharset();
        refresh();
      };
      return button;
    }),
  );
  $("text-copy").onclick = () => void copy();
  $("text-download").onclick = () => {
    if (text) download(`${name()}.txt`, new Blob([text], { type: "text/plain;charset=utf-8" }));
  };
  root.addEventListener("pointerdown", (e) => {
    if (e.target === root) close();
  });
  document.addEventListener(
    "keydown",
    (e) => {
      if (!opened || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    },
    true,
  );
  new ResizeObserver(fit).observe(scroll);

  return {
    get isOpen() {
      return opened;
    },
    open() {
      opened = true;
      root.hidden = false;
      paintCharset();
      view.focus();
      refresh();
    },
    close,
    refresh,
  };
}
