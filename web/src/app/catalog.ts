import type { Catalog } from "../types";

const empty: Catalog = { themes: [], darkThemes: [], engines: [], charsets: [], theme: -1, darkTheme: -1 };

let current = empty;

export const setCatalog = (next: Catalog): void => {
  current = next;
};

export const catalog = (): Catalog => current;
