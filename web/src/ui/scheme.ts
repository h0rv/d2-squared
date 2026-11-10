import { store } from "./store";

export type Scheme = "light" | "dark";

const KEY = "d2sq.scheme";
const system = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<(scheme: Scheme) => void>();

export function scheme(): Scheme {
  const saved = store.get(KEY);
  if (saved === "light" || saved === "dark") return saved;
  return system.matches ? "dark" : "light";
}

function apply(): void {
  const now = scheme();
  document.documentElement.dataset["scheme"] = now;
  document.documentElement.style.colorScheme = now;
  for (const listener of listeners) listener(now);
}

export function setScheme(next: Scheme): void {
  if (next === scheme()) return;
  store.set(KEY, next);
  apply();
}

export function onScheme(listener: (scheme: Scheme) => void): void {
  listeners.add(listener);
}

export const schemeCss = (css: string): string =>
  css.replace(/@media screen and \(prefers-color-scheme:\s*dark\)\s*\{/g, ':root[data-scheme="dark"] {');

system.addEventListener("change", apply);
apply();
