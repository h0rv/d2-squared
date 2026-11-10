import type { Editor } from "../editor/editor";
import type { Choice, Config, LayoutEngine, ThemeChoice, View } from "../types";
import { catalog } from "./catalog";

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

function fill(select: HTMLSelectElement, first: string, themes: ThemeChoice[]): void {
  select.replaceChildren(new Option(first, ""), ...themes.map((t) => new Option(t.name, String(t.id))));
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

export function wireSettings(editor: Editor, closeMenu: () => void): (view: View) => void {
  const theme = $<HTMLSelectElement>("theme");
  const dark = $<HTMLSelectElement>("dark-theme");
  const sketch = $("sketch");
  const { themes, darkThemes, engines: choices } = catalog();
  const engines = engineButtons($("engines"), choices);
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  let config: Config | null = null;
  fill(theme, "Default", themes);
  fill(dark, "Default (Dark Mauve)", darkThemes);

  const paintUse = (): void => {
    const night = scheme.matches;
    const darkSet = config?.darkThemeId !== undefined;
    $("theme-use").hidden = night && darkSet;
    $("dark-theme-use").hidden = !(night && darkSet);
  };
  scheme.addEventListener("change", paintUse);

  for (const button of engines) {
    button.onclick = () => {
      closeMenu();
      const to = button.dataset["engine"] as LayoutEngine;
      if (editor.view?.config.engine !== to) void editor.send({ kind: "config", key: "layout-engine", to });
    };
  }
  sketch.onclick = () => {
    closeMenu();
    void editor.send({ kind: "config", key: "sketch", to: String(sketch.getAttribute("aria-checked") !== "true") });
  };
  theme.onchange = () => {
    closeMenu();
    void editor.send({ kind: "config", key: "theme-id", to: theme.value });
  };
  dark.onchange = () => {
    closeMenu();
    void editor.send({ kind: "config", key: "dark-theme-id", to: dark.value });
  };

  return (view) => {
    config = view.config;
    for (const button of engines) button.setAttribute("aria-checked", String(button.dataset["engine"] === config.engine));
    sketch.setAttribute("aria-checked", String(config.sketch));
    theme.value = config.themeId === undefined ? "" : String(config.themeId);
    dark.value = config.darkThemeId === undefined ? "" : String(config.darkThemeId);
    paintUse();
  };
}
