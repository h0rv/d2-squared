import { catalog } from "../app/catalog";
import type { Edit } from "../types";

export const DIRECTIONS: Record<string, string> = { down: "Down", right: "Right", up: "Up", left: "Left" };

export function describeConfig(e: Edit): string {
  const to = e.to ?? "";
  const { themes, darkThemes, engines } = catalog();
  switch (e.key) {
    case "layout-engine":
      return `Layout engine: ${engines.find((x) => x.id === to)?.name ?? to}`;
    case "sketch":
      return `Sketch: ${to === "true" ? "on" : "off"}`;
    case "theme-id":
      return `Theme: ${to === "" ? "Default" : (themes.find((t) => String(t.id) === to)?.name ?? to)}`;
    case "dark-theme-id":
      return `Dark theme: ${to === "" ? "Default (Dark Mauve)" : (darkThemes.find((t) => String(t.id) === to)?.name ?? to)}`;
    default:
      return "Settings changed";
  }
}
