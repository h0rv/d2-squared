import type { Candidate, Catalog, Edit, Point, PreviewMessage, RouteResult, Target, TextResult, View } from "../types";
import { EngineError, type Engine } from "./engine";

export interface ServeInfo {
  mode: "serve";
  file: string;
}

export async function probeServe(base: string): Promise<ServeInfo | null> {
  try {
    const res = await fetch(`${base}api/info`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const info = (await res.json()) as Partial<ServeInfo>;
    return info.mode === "serve" && typeof info.file === "string" ? { mode: "serve", file: info.file } : null;
  } catch {
    return null;
  }
}

export class HttpEngine implements Engine {
  readonly kind = "http";
  private readonly base: string;
  private listeners = new Set<(view: View) => void>();
  private watching: AbortController | null = null;
  private latest = -1;

  constructor(base = "") {
    this.base = base;
  }

  private post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(this.base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });
  }

  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) throw new EngineError(await res.text(), res.status);
    return (await res.json()) as T;
  }

  async current(): Promise<View | null> {
    const res = await fetch(`${this.base}api/view?since=-1`);
    if (res.status === 204) return null;
    const view = await this.json<View>(res);
    this.latest = Math.max(this.latest, view.version);
    return view;
  }

  subscribe(listener: (view: View) => void): () => void {
    this.listeners.add(listener);
    if (!this.watching) void this.watch();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.watching?.abort();
        this.watching = null;
      }
    };
  }

  private async watch(): Promise<void> {
    const control = new AbortController();
    this.watching = control;
    while (!control.signal.aborted) {
      try {
        const res = await fetch(`${this.base}api/view?since=${this.latest}&wait=1`, { signal: control.signal });
        if (res.status === 204) continue;
        const view = await this.json<View>(res);
        if (view.version > this.latest) {
          this.latest = view.version;
          for (const listener of this.listeners) listener(view);
        }
      } catch {
        if (control.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  async *preview(target: Target, at: Point, version: number, signal: AbortSignal): AsyncGenerator<PreviewMessage> {
    const res = await this.post("api/preview", { target, at, version }, signal);
    if (!res.ok || !res.body) throw new EngineError(await res.text(), res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as PreviewMessage;
        newline = buffer.indexOf("\n");
      }
    }
  }

  async route(target: Target, delta: Point, version: number, signal: AbortSignal): Promise<RouteResult> {
    return this.json(await this.post("api/route", { target, delta, version }, signal));
  }

  async candidate(edit: Edit, version: number, signal: AbortSignal): Promise<Candidate> {
    return this.json(await this.post("api/candidate", { edit, version }, signal));
  }

  async commit(edit: Edit, version: number): Promise<View> {
    const view = await this.json<View>(await this.post("api/commit", { edit, version }));
    this.latest = Math.max(this.latest, view.version);
    return view;
  }

  async undo(): Promise<View> {
    const view = await this.json<View>(await this.post("api/undo", {}));
    this.latest = Math.max(this.latest, view.version);
    return view;
  }

  async redo(): Promise<View> {
    const view = await this.json<View>(await this.post("api/redo", {}));
    this.latest = Math.max(this.latest, view.version);
    return view;
  }

  async text(unicode: boolean): Promise<TextResult> {
    return this.json(await fetch(`${this.base}api/text?charset=${unicode ? "unicode" : "ascii"}`));
  }

  async catalog(): Promise<Catalog> {
    return this.json(await fetch(`${this.base}api/catalog`));
  }

  async exportSvg(dark: boolean): Promise<string> {
    const res = await fetch(`${this.base}api/export/svg${dark ? "?dark=1" : ""}`);
    if (!res.ok) throw new EngineError(await res.text(), res.status);
    return res.text();
  }
}
