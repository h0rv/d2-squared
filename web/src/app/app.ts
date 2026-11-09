import type { Engine } from "../engine/engine";
import { HttpEngine, probeServe } from "../engine/http-engine";
import { mount, type Editor } from "../editor/editor";
import { mountCode, type CodePanel } from "../ui/code";
import { ICONS, type IconName } from "../ui/icons";
import { store } from "../ui/store";
import { mountToasts, type Toasts } from "../ui/toast";
import { EXAMPLES } from "./examples";
import { LocalFile } from "./files";
import { decodeShare, encodeShare } from "./share";

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

declare const WASM_BYTES: number;

const HINT_KEY = "d2sq.hint";
const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl+";
const PHONE = "(max-width: 700px)";

function showLoading(text: string, fraction: number | null): void {
  $("loading-text").textContent = text;
  const bar = $("loading-bar");
  bar.classList.toggle("indeterminate", fraction === null);
  bar.style.transform = `scaleX(${fraction ?? 1})`;
}

function hideLoading(): void {
  const loading = $("loading");
  loading.classList.add("done");
  document.body.dataset["ready"] = "1";
  window.setTimeout(() => {
    loading.hidden = true;
  }, 360);
}

async function createWasmEngine(): Promise<Engine> {
  const [{ loadWasm }, { WasmEngine }] = await Promise.all([import("../engine/load-wasm"), import("../engine/wasm-engine")]);
  showLoading("Loading the layout engine…", null);
  const module = await loadWasm(`${import.meta.env.BASE_URL}d2squared.wasm`, (loaded, total) => {
    const known = total || WASM_BYTES;
    showLoading("Loading the layout engine…", known > 0 ? Math.min(loaded / known, 1) : null);
  });
  showLoading("Starting the layout engine…", null);
  const requested = Number(new URLSearchParams(location.search).get("workers"));
  return WasmEngine.create(module, requested > 0 ? { workers: requested } : {});
}

function paintIcons(): void {
  const map: Record<string, IconName> = {
    github: "github",
    undo: "undo",
    redo: "redo",
    more: "more",
    "zoom-out": "minus",
    "zoom-in": "plus",
    fit: "fit",
    "code-close": "close",
  };
  for (const [id, name] of Object.entries(map)) $(id).innerHTML = ICONS[name];
  $("code-toggle").innerHTML = `${ICONS.code}<span>Code</span>`;
  for (const button of document.querySelectorAll<HTMLElement>("[data-dir]")) button.innerHTML = ICONS[button.dataset["dir"] as IconName];
  $("undo").dataset["tip"] = `Undo · ${MOD}Z`;
  $("redo").dataset["tip"] = `Redo · ${MOD === "⌘" ? "⇧⌘Z" : "Ctrl+Shift+Z"}`;
  $("fit").dataset["tip"] = "Fit to screen · F";
}

interface Chrome {
  panel: CodePanel;
  toasts: Toasts;
}

function wireCanvas(editor: Editor, chrome: Chrome): void {
  const { panel, toasts } = chrome;
  const undo = $<HTMLButtonElement>("undo");
  const redo = $<HTMLButtonElement>("redo");
  editor.on("view", (v) => {
    panel.setSource(v);
    undo.disabled = !v.canUndo;
    redo.disabled = !v.canRedo;
  });
  editor.on("pending", (change) => panel.setPending(change));
  editor.on("error", (message) => {
    panel.setError(message);
    if (message && !panel.open) toasts.show(message, { error: true, ms: 6000 });
  });
  editor.on("status", (text, kind) => {
    if (kind === "busy") toasts.busy(text);
    else if (kind === "err") toasts.show(text, { error: true, ms: 6000 });
    else if (kind === "done") {
      const history = text === "Undone" || text === "Redone";
      toasts.show(text, !history && !undo.disabled ? { action: { label: "Undo", run: () => void editor.undo() } } : {});
    }
  });
  editor.on("zoom", (scale) => {
    $("zoom-level").textContent = `${Math.round(scale * 100)}%`;
  });
  editor.on("select", (id) => {
    $("dir-label").textContent = id ? `Direction inside ${editor.label(id)}` : "Layout direction";
  });
  undo.onclick = () => void editor.undo();
  redo.onclick = () => void editor.redo();
  $("fit").onclick = () => editor.fit(true);
  $("zoom-in").onclick = () => editor.zoomBy(1.25);
  $("zoom-out").onclick = () => editor.zoomBy(0.8);
  $("reset").onclick = () => {
    closeMenu();
    void editor.send({ kind: "unpin", key: "" });
  };
  for (const button of document.querySelectorAll<HTMLElement>("[data-dir]")) {
    button.onclick = () => {
      closeMenu();
      void editor.send({ kind: "direction", key: editor.selected, to: button.dataset["dir"] ?? "" });
    };
  }
}

function closeMenu(): void {
  const menu = $("menu");
  if (menu.hidden) return;
  menu.hidden = true;
  $("more").setAttribute("aria-expanded", "false");
}

function wireMenu(): void {
  const menu = $("menu");
  const items = (): HTMLElement[] => [...menu.querySelectorAll<HTMLElement>(".menu-item")].filter((n) => !n.closest("[hidden]"));
  $("more").onclick = (e) => {
    e.stopPropagation();
    if (!menu.hidden) return closeMenu();
    menu.hidden = false;
    $("more").setAttribute("aria-expanded", "true");
    items()[0]?.focus();
  };
  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && !$("more").contains(e.target as Node)) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (menu.hidden) return;
    if (e.key === "Escape") {
      closeMenu();
      $("more").focus();
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLElement);
      list[(at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    }
  });
}

function dismissHint(): void {
  store.set(HINT_KEY, "1");
  const hint = $("hint");
  hint.classList.add("gone");
  document.body.classList.remove("hint-on");
  window.setTimeout(() => {
    hint.hidden = true;
  }, 400);
}

function showHint(): void {
  if (store.get(HINT_KEY) === "1") return;
  $("hint").hidden = false;
  document.body.classList.add("hint-on");
}

function wireSite(engine: Engine, editor: Editor, toasts: Toasts, state: { custom: boolean }): void {
  const open = engine.open?.bind(engine);
  if (!open) return;
  const local = new LocalFile();
  const select = $<HTMLSelectElement>("example");
  const chips = $("chips");
  const choose = (id: string): void => {
    select.value = id;
    for (const chip of chips.querySelectorAll<HTMLButtonElement>("button"))
      chip.setAttribute("aria-checked", String(chip.dataset["example"] === id));
  };
  const addExample = (id: string, title: string): void => {
    select.add(new Option(title, id));
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip-btn";
    chip.setAttribute("role", "radio");
    chip.dataset["example"] = id;
    chip.textContent = title;
    chip.setAttribute("aria-checked", "false");
    chip.onclick = () => select.value !== id && pick(id);
    chips.append(chip);
  };
  const load = async (source: string): Promise<void> => {
    toasts.busy("Laying out the diagram…");
    try {
      await open(source);
    } finally {
      toasts.hide();
    }
  };
  const pick = (id: string): void => {
    const ex = EXAMPLES.find((x) => x.id === id);
    if (!ex) return;
    choose(id);
    history.replaceState(null, "", location.pathname + location.search);
    void load(ex.source);
  };
  const addCustom = (title: string): void => {
    for (const node of document.querySelectorAll('[data-example="custom"], option[value="custom"]')) node.remove();
    addExample("custom", title);
    choose("custom");
  };
  for (const ex of EXAMPLES) addExample(ex.id, ex.title);
  select.onchange = () => pick(select.value);
  $("examples").hidden = false;
  if (state.custom) addCustom("Shared diagram");
  else choose(EXAMPLES[0]!.id);

  $("open").onclick = async () => {
    closeMenu();
    const file = await local.open();
    if (!file) return;
    addCustom(file.name);
    await load(file.text);
  };
  $("save").onclick = async () => {
    closeMenu();
    const name = await local.save(editor.view?.source ?? "");
    if (name) toasts.show(`Saved ${name}`);
  };
  $("share").onclick = async () => {
    closeMenu();
    const hash = await encodeShare(editor.view?.source ?? "");
    history.replaceState(null, "", hash);
    try {
      await navigator.clipboard.writeText(location.href);
      toasts.show("Link copied");
    } catch {
      toasts.show("The link is in the address bar");
    }
  };
}

function firstView(editor: Editor): Promise<void> {
  if (editor.view) return Promise.resolve();
  return new Promise((resolve) => {
    editor.on("view", () => resolve());
    editor.on("error", (message) => message && resolve());
  });
}

export async function start(): Promise<void> {
  paintIcons();
  wireMenu();
  const base = import.meta.env.BASE_URL;
  const info = import.meta.env.MODE === "production" ? null : await probeServe(base);
  const engine: Engine = info ? new HttpEngine(base) : await createWasmEngine();
  const toasts = mountToasts($("toast"));
  const phone = matchMedia(PHONE);
  let editor: Editor | null = null;
  const layout = (animate: boolean): void => {
    if (!editor) return;
    const extent = panel.extent();
    const top = phone.matches && !info ? 112 : 72;
    const pad = phone.matches ? { left: 16, right: 16, bottom: extent.bottom ? 64 : 88 } : { left: 32, right: 32, bottom: 72 };
    editor.setInsets({ top, left: pad.left, right: pad.right + extent.right, bottom: pad.bottom + extent.bottom }, animate);
    document.body.style.setProperty("--inset-r", `${extent.right}px`);
    document.body.style.setProperty("--inset-b", `${extent.bottom}px`);
  };
  const panel = mountCode($("code"), {
    readOnly: !engine.reload,
    onEdit: (text) => void engine.reload?.(text),
    onLayout: layout,
    onToggle: (open) => {
      $("code-toggle").setAttribute("aria-pressed", String(open));
      $("code-toggle").dataset["tip"] = open ? "Hide the D2 code" : "Show the D2 code";
    },
  });
  $("code-toggle").onclick = () => panel.toggle();
  $("code-toggle").setAttribute("aria-pressed", String(panel.open));
  editor = mount($("editor"), engine, { onEdit: dismissHint });
  window.editor = editor;
  phone.addEventListener("change", () => layout(false));
  layout(false);
  wireCanvas(editor, { panel, toasts });
  if (info) {
    $("tagline").hidden = true;
    const name = document.createElement("span");
    name.id = "filename";
    name.className = "filename";
    name.textContent = info.file;
    name.title = info.file;
    $("tagline").after(name);
    for (const node of document.querySelectorAll<HTMLElement>(".site-only")) node.hidden = true;
    await firstView(editor);
    showHint();
    hideLoading();
    return;
  }
  const shared = await decodeShare(location.hash);
  wireSite(engine, editor, toasts, { custom: shared !== null });
  showLoading("Laying out the diagram…", null);
  await engine.open?.(shared ?? EXAMPLES[0]!.source);
  showHint();
  hideLoading();
}
