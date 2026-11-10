import type { Catalog } from "../types";

const empty: Catalog = { themes: [], darkThemes: [], engines: [], charsets: [] };

let current = empty;

export const setCatalog = (next: Catalog): void => {
  current = next;
};

export const catalog = (): Catalog => current;
