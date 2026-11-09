import { themeName } from "../app/themes";
import type { Edit } from "../types";

const ENGINES: Record<string, string> = { tala: "TALA", elk: "ELK", dagre: "dagre" };

export const DIRECTIONS: Record<string, string> = { down: "Down", right: "Right", up: "Up", left: "Left" };

export function describeConfig(e: Edit): string {
  const to = e.to ?? "";
  switch (e.key) {
    case "layout-engine":
      return `Layout engine: ${ENGINES[to] ?? to}`;
    case "sketch":
      return `Sketch: ${to === "true" ? "on" : "off"}`;
    case "theme-id":
      return `Theme: ${themeName(Number(to))}`;
    case "dark-theme-id":
      return `Dark theme: ${themeName(Number(to))}`;
    default:
      return "Settings changed";
  }
}
