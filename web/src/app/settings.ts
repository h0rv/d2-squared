import type { Editor } from "../editor/editor";
import type { LayoutEngine, View } from "../types";
import { DARK_THEMES, LIGHT_THEMES, type ThemeChoice } from "./themes";

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

function fill(select: HTMLSelectElement, themes: ThemeChoice[]): void {
  select.replaceChildren(...themes.map((t) => new Option(t.name, String(t.id))));
}

export function wireSettings(editor: Editor, closeMenu: () => void): (view: View) => void {
  const theme = $<HTMLSelectElement>("theme");
  const dark = $<HTMLSelectElement>("dark-theme");
  const sketch = $("sketch");
  const engines = [...document.querySelectorAll<HTMLElement>("[data-engine]")];
  fill(theme, LIGHT_THEMES);
  fill(dark, DARK_THEMES);

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
    const { config } = view;
    for (const button of engines) button.setAttribute("aria-checked", String(button.dataset["engine"] === config.engine));
    sketch.setAttribute("aria-checked", String(config.sketch));
    theme.value = String(config.themeId);
    dark.value = String(config.darkThemeId);
  };
}
