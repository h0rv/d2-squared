import type { Engine } from "../engine/engine";
import { HttpEngine, probeServe } from "../engine/http-engine";
import { mount, type Editor } from "../editor/editor";
import type { View } from "../types";
import { DEFAULT_HINT, EXAMPLES, type Example } from "./examples";
import { LocalFile } from "./files";
import { decodeShare, encodeShare } from "./share";

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

declare const WASM_BYTES: number;

function showLoading(text: string, fraction: number | null): void {
  $("loading").hidden = false;
  $("loading-text").textContent = text;
  const bar = $<HTMLProgressElement>("loading-bar");
  if (fraction === null) bar.removeAttribute("value");
  else bar.value = fraction;
}

const hideLoading = () => {
  $("loading").hidden = true;
};

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

function renderSource(v: View): void {
  const pre = $("source");
  const changed = new Set(v.changed ?? []);
  const frag = document.createDocumentFragment();
  let first: HTMLElement | null = null;
  v.source
    .replace(/\n$/, "")
    .split("\n")
    .forEach((line, i) => {
      const row = document.createElement("div");
      const hit = changed.has(i + 1);
      row.className = "ln" + (hit ? " hl" : "");
      row.dataset["n"] = String(i + 1);
      row.textContent = line || " ";
      if (hit && !first) first = row;
      frag.appendChild(row);
    });
  pre.replaceChildren(frag);
  (first as HTMLElement | null)?.scrollIntoView({ block: "center" });
}

function wireStatus(editor: Editor): void {
  editor.on("status", (text, kind, title) => {
    if (text !== undefined) {
      const status = $("status");
      status.textContent = text;
      status.className = kind ?? "";
      status.title = title ?? "";
      if (kind === "done" && !$<HTMLButtonElement>("undo").disabled && text !== "Undone") {
        const link = document.createElement("button");
        link.textContent = "Undo";
        link.className = "link";
        link.onclick = () => void editor.undo();
        status.append(" · ", link);
      }
    }
    $<HTMLInputElement>("zoom").value = String(editor.scale);
  });
  editor.on("view", (v) => {
    renderSource(v);
    $<HTMLButtonElement>("undo").disabled = !v.canUndo;
    $<HTMLButtonElement>("redo").disabled = !v.canRedo;
  });
  editor.on("select", (id) => {
    $<HTMLSelectElement>("dir").dataset["target"] = id;
  });
}

function wireControls(editor: Editor): void {
  $("undo").onclick = () => void editor.undo();
  $("redo").onclick = () => void editor.redo();
  $("fit").onclick = () => editor.fit();
  $<HTMLInputElement>("zoom").oninput = (e) => editor.setScale(parseFloat((e.target as HTMLInputElement).value));
  $("unpin").onclick = () => void editor.send({ kind: "unpin", key: "" });
  $<HTMLSelectElement>("dir").onchange = (e) => {
    const select = e.target as HTMLSelectElement;
    if (select.value) void editor.send({ kind: "direction", key: editor.selected, to: select.value });
    select.value = "";
  };
  $("source-toggle").onclick = () => {
    const hidden = document.body.classList.toggle("no-panel");
    $("source-toggle").setAttribute("aria-pressed", String(!hidden));
    requestAnimationFrame(() => editor.fit());
  };
  document.addEventListener("click", (e) => {
    const menu = $<HTMLDetailsElement>("more");
    if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $<HTMLDetailsElement>("more").open = false;
  });
}

function wireSiteControls(engine: Engine, editor: Editor, hint: { current: string }): void {
  const reload = engine.reload?.bind(engine);
  const open = engine.open?.bind(engine);
  if (!reload || !open) return;
  const local = new LocalFile();
  const select = $<HTMLSelectElement>("example");
  select.hidden = false;
  for (const ex of EXAMPLES) select.add(new Option(ex.title, ex.id));
  const load = async (source: string, text: string): Promise<void> => {
    hint.current = text;
    $<HTMLTextAreaElement>("source-edit").hidden = true;
    $("source").hidden = false;
    setEditing(false);
    await open(source);
  };
  const setEditing = (on: boolean): void => {
    $("edit").hidden = on;
    $("apply").hidden = !on;
    $("cancel").hidden = !on;
    $("source").hidden = on;
    $<HTMLTextAreaElement>("source-edit").hidden = !on;
    if (on) {
      const area = $<HTMLTextAreaElement>("source-edit");
      area.value = editor.view?.source ?? "";
      area.focus();
    }
  };
  const apply = async (): Promise<void> => {
    await reload($<HTMLTextAreaElement>("source-edit").value);
    if (!editor.view?.error) setEditing(false);
  };
  select.onchange = () => {
    const ex = EXAMPLES.find((x) => x.id === select.value);
    if (ex) void load(ex.source, ex.hint);
  };
  $("edit").onclick = () => setEditing(true);
  $("cancel").onclick = () => setEditing(false);
  $("apply").onclick = () => void apply();
  $<HTMLTextAreaElement>("source-edit").onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void apply();
    if (e.key === "Escape") setEditing(false);
  };
  $("open").onclick = async () => {
    $<HTMLDetailsElement>("more").open = false;
    const file = await local.open();
    if (file) {
      select.add(new Option(file.name, "file"));
      select.value = "file";
      await load(file.text, DEFAULT_HINT);
    }
  };
  $("save").onclick = async () => {
    $<HTMLDetailsElement>("more").open = false;
    const name = await local.save(editor.view?.source ?? "");
    if (name) $("status").textContent = `Saved ${name}`;
  };
  $("share").onclick = async () => {
    $<HTMLDetailsElement>("more").open = false;
    const hash = await encodeShare(editor.view?.source ?? "");
    history.replaceState(null, "", hash);
    try {
      await navigator.clipboard.writeText(location.href);
      $("status").textContent = "Link copied";
    } catch {
      $("status").textContent = "The link is in the address bar";
    }
  };
}

export async function start(): Promise<void> {
  const base = import.meta.env.BASE_URL;
  const info = await probeServe(base);
  const hint = { current: DEFAULT_HINT };
  const engine: Engine = info ? new HttpEngine(base) : await createWasmEngine();
  const editor = mount($("editor"), engine, { hint: () => hint.current });
  window.editor = editor;
  wireStatus(editor);
  wireControls(editor);
  if (info) {
    document.querySelectorAll(".site-only").forEach((n) => ((n as HTMLElement).hidden = true));
    $("filename").hidden = false;
    $("filename").textContent = info.file;
    hideLoading();
    return;
  }
  wireSiteControls(engine, editor, hint);
  const shared = await decodeShare(location.hash);
  const first: Example = EXAMPLES[0]!;
  if (shared) {
    $<HTMLSelectElement>("example").add(new Option("Shared diagram", "shared"));
    $<HTMLSelectElement>("example").value = "shared";
    hint.current = DEFAULT_HINT;
  } else {
    hint.current = first.hint;
  }
  showLoading("Laying out the diagram…", null);
  await engine.open?.(shared ?? first.source);
  hideLoading();
}
