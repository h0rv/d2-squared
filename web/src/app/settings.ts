import type { Editor } from "../editor/editor";
import type { Choice, Config, LayoutEngine, ThemeChoice, View } from "../types";
import { catalog } from "./catalog";
import { ICONS } from "../ui/icons";
import { onScheme, scheme, setScheme, type Scheme } from "../ui/scheme";

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

function group(label: string, mode: Scheme, fallback: number, themes: ThemeChoice[]): HTMLOptGroupElement {
  const node = document.createElement("optgroup");
  node.label = label;
  const named = themes.find((t) => t.id === fallback)?.name;
  node.append(
    new Option(named ? `Default (${named})` : "Default", `${mode}:`),
    ...themes.filter((t) => t.id !== fallback).map((t) => new Option(t.name, `${mode}:${t.id}`)),
  );
  return node;
}

function engineButtons(host: HTMLElement, engines: Choice[]): HTMLElement[] {
  host.replaceChildren(
    ...engines.map((engine) => {
      const button = document.createElement("button");
      button.className = "menu-item";
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", "false");
      button.dataset["engine"] = engine.id;
      button.textContent = engine.name;
      return button;
    }),
  );
  return [...host.querySelectorAll<HTMLElement>("[data-engine]")];
}

export function wireSettings(editor: Editor): (view: View) => void {
  const theme = $<HTMLSelectElement>("theme");
  const sketch = $("sketch");
  const toggle = $("scheme");
  const { themes, darkThemes, engines: choices, theme: lightDefault, darkTheme: darkDefault } = catalog();
  const engines = engineButtons($("engines"), choices);
  let config: Config | null = null;
  theme.replaceChildren(group("Light", "light", lightDefault, themes), group("Dark", "dark", darkDefault, darkThemes));

  const paintTheme = (): void => {
    const mode = scheme();
    const id = mode === "dark" ? config?.darkThemeId : config?.themeId;
    theme.value = `${mode}:${id ?? ""}`;
    const next = mode === "dark" ? "light" : "dark";
    toggle.innerHTML = ICONS[mode === "dark" ? "sun" : "moon"];
    toggle.setAttribute("aria-label", `Switch to ${next} mode`);
    toggle.dataset["tip"] = `Switch to ${next} mode`;
  };
  onScheme(paintTheme);
  toggle.onclick = () => setScheme(scheme() === "dark" ? "light" : "dark");

  for (const button of engines) {
    button.onclick = () => {
      const to = button.dataset["engine"] as LayoutEngine;
      if (editor.view?.config.engine !== to) void editor.send({ kind: "config", key: "layout-engine", to });
    };
  }
  sketch.onclick = () => {
    void editor.send({ kind: "config", key: "sketch", to: String(sketch.getAttribute("aria-checked") !== "true") });
  };
  theme.onchange = () => {
    const [mode, id = ""] = theme.value.split(":") as [Scheme, string];
    setScheme(mode);
    void editor.send({ kind: "config", key: mode === "dark" ? "dark-theme-id" : "theme-id", to: id });
  };

  return (view) => {
    config = view.config;
    for (const button of engines) button.setAttribute("aria-checked", String(button.dataset["engine"] === config.engine));
    sketch.setAttribute("aria-checked", String(config.sketch));
    paintTheme();
  };
}
