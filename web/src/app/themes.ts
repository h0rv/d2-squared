export interface ThemeChoice {
  id: number;
  name: string;
}

export const LIGHT_THEMES: ThemeChoice[] = [
  { id: 0, name: "Neutral default" },
  { id: 1, name: "Neutral grey" },
  { id: 3, name: "Flagship Terrastruct" },
  { id: 4, name: "Cool classics" },
  { id: 5, name: "Mixed berry blue" },
  { id: 6, name: "Grape soda" },
  { id: 7, name: "Aubergine" },
  { id: 8, name: "Colorblind clear" },
  { id: 100, name: "Vanilla nitro cola" },
  { id: 101, name: "Orange creamsicle" },
  { id: 102, name: "Shirley temple" },
  { id: 103, name: "Earth tones" },
  { id: 104, name: "Everglade green" },
  { id: 105, name: "Buttered toast" },
  { id: 300, name: "Terminal" },
  { id: 301, name: "Terminal grayscale" },
  { id: 302, name: "Origami" },
  { id: 303, name: "C4" },
];

export const DARK_THEMES: ThemeChoice[] = [
  { id: 200, name: "Dark mauve" },
  { id: 201, name: "Dark Flagship Terrastruct" },
];

export const themeName = (id: number): string => [...LIGHT_THEMES, ...DARK_THEMES].find((t) => t.id === id)?.name ?? "this theme";
