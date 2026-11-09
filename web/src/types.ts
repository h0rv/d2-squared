export interface Point {
  x: number;
  y: number;
}

export interface Shape {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pinned: boolean;
  cols?: string[];
  pk: number;
}

export interface Conn {
  id: string;
  src: string;
  dst: string;
  route: [number, number][];
}

export type Path = Conn;

export interface DiffLine {
  op: string;
  text?: string;
}

export interface Edit {
  kind: "move" | "reconnect" | "pin" | "unpin" | "direction";
  key: string;
  to?: string;
  end?: string;
  left?: number;
  top?: number;
}

export type Target = { kind: "node"; id: string } | { kind: "edgeEnd"; edge: string; end: "src" | "dst" };

export interface Candidate {
  key: string;
  label: string;
  edit: Edit;
  landing: Shape;
  route?: [number, number][];
  diff: DiffLine[];
  pinLines: number;
  ms: number;
  cached: boolean;
}

export interface Piece {
  id: string;
  svg: string;
}

export interface Scene {
  css: string;
  defs: string;
  shapes: Piece[];
  connections: Piece[];
}

export interface View {
  version: number;
  source: string;
  error?: string;
  cause: "open" | "reload" | "commit" | "undo" | "redo" | "error";
  changed: number[];
  canUndo: boolean;
  canRedo: boolean;
  ms: number;
  scene: Scene;
  shapes: Shape[];
  conns: Conn[];
  originY: number;
  layoutMs: number;
}

export type PreviewMessage = { candidate: Candidate } | { done: true; count: number; ms: number };

export interface RouteResult {
  paths: Path[];
}

export interface PendingChange {
  title: string;
  lines?: DiffLine[];
  working?: boolean;
  saved?: number;
}
