import type { Engine } from "../engine/engine";
import { within } from "../geometry";
import { HttpEngine, probeServe } from "../engine/http-engine";
import { mount, type Editor } from "../editor/editor";
import { mountCode, type CodePanel } from "../ui/code";
import { ICONS, type IconName } from "../ui/icons";
import { store } from "../ui/store";
import { mountTextModal, type TextModal } from "../ui/textview";
import { mountToasts, type Toasts } from "../ui/toast";
import { PLACING_NEEDS_TALA } from "../editor/zones";
import { setCatalog } from "./catalog";
import { EXAMPLES } from "./examples";
import { exportAs, type ExportKind } from "./export";
import { LocalFile } from "./files";
import { wireSettings } from "./settings";
import { decodeShare, encodeShare } from "./share";

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

declare const WASM_BYTES: number;
declare const WASM_URL: string;

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
  showLoading("Laying out the diagram…", null);
  const { module } = await loadWasm(WASM_URL, {
    onNetwork: () => showLoading("Loading the layout engine…", null),
    onProgress: (loaded, total) => {
      const known = total || WASM_BYTES;
      showLoading("Loading the layout engine…", known > 0 ? Math.min(loaded / known, 1) : null);
    },
  });
  showLoading("Laying out the diagram…", null);
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
  textModal: TextModal;
}

function wireExport(engine: Engine, toasts: Toasts, textModal: TextModal, name: () => string): void {
  $("text-export").onclick = () => {
    closeMenu();
    textModal.open();
  };
  for (const button of document.querySelectorAll<HTMLElement>("[data-export]")) {
    button.onclick = async () => {
      closeMenu();
      toasts.busy("Preparing the file…");
      try {
        toasts.show(await exportAs(button.dataset["export"] as ExportKind, engine, name()));
      } catch (err) {
        toasts.show(err instanceof Error ? err.message : "The file could not be exported.", { error: true, ms: 6000 });
      }
    };
  }
}

function wireCanvas(editor: Editor, chrome: Chrome): void {
  const { panel, toasts, textModal } = chrome;
  const undo = $<HTMLButtonElement>("undo");
  const redo = $<HTMLButtonElement>("redo");
  const paintSettings = wireSettings(editor);
  editor.on("view", (v) => {
    panel.setSource(v);
    paintSettings(v);
    textModal.refresh();
    if (hintState.limited !== (v.config.engine !== "tala")) {
      hintState.limited = v.config.engine !== "tala";
      paintHint();
    }
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
  const paintArrange = (): void => {
    const id = editor.selected;
    const shapes = editor.view?.shapes ?? [];
    const saved = id !== "" && shapes.some((s) => s.pinned && s.id !== id && within(s.id, id));
    $("tidy").hidden = !saved;
    $("tidy").textContent = saved ? `Auto-arrange ${editor.label(id)}` : "Auto-arrange";
    $("reset").hidden = !shapes.some((s) => s.pinned);
  };
  editor.on("view", paintArrange);
  editor.on("select", (id) => {
    $("dir-label").textContent = id ? `Direction inside ${editor.label(id)}` : "Layout direction";
    paintArrange();
  });
  $("tidy").onclick = () => {
    closeMenu();
    void editor.send({ kind: "tidy", key: editor.selected });
  };
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

const HINT_TEXT = "Drag a box into another group, or drag an arrow's end onto another box";
const HINT_SITE = "Drag a box into another group. Drop your own .d2 file here to try it.";
const HINT_SHORT = "Drag a box into a group";
const HINT_LIMITED = PLACING_NEEDS_TALA;

const hintState = { armed: false, limited: false, site: false };
const narrow = window.matchMedia(PHONE);

function paintHint(): void {
  const hint = $("hint");
  const wanted = hintState.armed && (hintState.limited || store.get(HINT_KEY) !== "1");
  hint.textContent = hintState.limited ? HINT_LIMITED : narrow.matches ? HINT_SHORT : hintState.site ? HINT_SITE : HINT_TEXT;
  hint.hidden = !wanted;
  hint.classList.toggle("gone", !wanted);
  document.body.classList.toggle("hint-on", wanted);
}

narrow.addEventListener("change", paintHint);

function dismissHint(): void {
  if (hintState.limited) return;
  store.set(HINT_KEY, "1");
  const hint = $("hint");
  hint.classList.add("gone");
  document.body.classList.remove("hint-on");
  window.setTimeout(() => {
    if (!hintState.limited) hint.hidden = true;
  }, 400);
}

function showHint(): void {
  hintState.armed = true;
  paintHint();
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
  const own = document.createElement("button");
  own.type = "button";
  own.className = "chip-btn";
  own.id = "open-own";
  own.textContent = "Open your own";
  own.dataset["tip"] = "Open a .d2 file. You can also drop a file here or paste D2.";
  const ownOption = new Option("Open your own…", "own");
  const addExample = (id: string, title: string): void => {
    select.add(new Option(title, id), ownOption);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip-btn";
    chip.setAttribute("role", "radio");
    chip.dataset["example"] = id;
    chip.textContent = title;
    chip.setAttribute("aria-checked", "false");
    chip.onclick = () => select.value !== id && pick(id);
    chips.insertBefore(chip, own);
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
  chips.append(own);
  select.add(ownOption);
  for (const ex of EXAMPLES) addExample(ex.id, ex.title);
  select.onchange = () => {
    if (select.value !== "own") return pick(select.value);
    select.value = chips.querySelector('[aria-checked="true"]')?.getAttribute("data-example") ?? EXAMPLES[0]!.id;
    void openFile();
  };
  $("examples").hidden = false;
  hintState.site = true;
  paintHint();
  if (state.custom) addCustom("Shared diagram");
  else choose(EXAMPLES[0]!.id);

  const replaceWith = async (title: string, source: string, message: string): Promise<void> => {
    const previous = editor.view?.source ?? "";
    const before = chips.querySelector<HTMLElement>('[aria-checked="true"]')?.dataset["example"] ?? EXAMPLES[0]!.id;
    const beforeTitle = chips.querySelector<HTMLElement>('[data-example="custom"]')?.textContent ?? title;
    try {
      await load(source);
    } catch (err) {
      toasts.show(err instanceof Error && err.message ? err.message : "That is not a D2 diagram.", { error: true, ms: 6000 });
      return;
    }
    addCustom(title);
    dismissHint();
    toasts.show(message, {
      action: {
        label: "Undo",
        run: () => {
          if (before === "custom") addCustom(beforeTitle);
          else {
            for (const node of document.querySelectorAll('[data-example="custom"], option[value="custom"]')) node.remove();
            choose(before);
          }
          void load(previous);
        },
      },
    });
  };
  const openFile = async (): Promise<void> => {
    const file = await local.open();
    if (file) await replaceWith(file.name, file.text, `Opened ${file.name}`);
  };
  $("open").onclick = () => {
    closeMenu();
    void openFile();
  };
  own.onclick = () => void openFile();
  const overlay = $("drop");
  let depth = 0;
  const carriesFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
  const hideDrop = (): void => {
    depth = 0;
    overlay.hidden = true;
  };
  window.addEventListener("dragenter", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    depth += 1;
    overlay.hidden = false;
  });
  window.addEventListener("dragover", (e) => {
    if (carriesFiles(e)) e.preventDefault();
  });
  window.addEventListener("dragleave", (e) => {
    if (!carriesFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  window.addEventListener("drop", async (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    hideDrop();
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    if (!/\.(d2|txt)$/i.test(file.name)) {
      toasts.show("Drop a .d2 or .txt file.", { error: true });
      return;
    }
    await replaceWith(file.name, await file.text(), `Opened ${file.name}`);
  });
  document.addEventListener("paste", async (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("input, textarea, select, [contenteditable], #code")) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text.trim()) return;
    e.preventDefault();
    await replaceWith("Pasted diagram", text, "Pasted your diagram");
  });
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
  setCatalog(await engine.catalog());
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
  const exportName = () => (info ? info.file.replace(/\.[^.]+$/, "") : "diagram");
  const textModal = mountTextModal($("text-modal"), engine, toasts, exportName);
  wireCanvas(editor, { panel, toasts, textModal });
  wireExport(engine, toasts, textModal, () => (info ? info.file.replace(/\.[^.]+$/, "") : "diagram"));
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
