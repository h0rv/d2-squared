import type { Candidate, Edit, Point, PreviewMessage, RouteResult, Target, TextResult, View } from "../types";

export interface Engine {
  readonly kind: "http" | "wasm";
  current(): Promise<View | null>;
  subscribe(listener: (view: View) => void): () => void;
  preview(target: Target, at: Point, version: number, signal: AbortSignal): AsyncIterable<PreviewMessage>;
  route(target: Target, delta: Point, version: number, signal: AbortSignal): Promise<RouteResult>;
  candidate(edit: Edit, version: number, signal: AbortSignal): Promise<Candidate>;
  commit(edit: Edit, version: number): Promise<View>;
  undo(): Promise<View>;
  redo(): Promise<View>;
  text(unicode: boolean): Promise<TextResult>;
  exportSvg(dark: boolean): Promise<string>;
  open?(source: string): Promise<View>;
  reload?(source: string): Promise<View>;
}

export class EngineError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}
