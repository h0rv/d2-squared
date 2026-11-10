import type { Candidate, Edit, Point, PreviewMessage, RouteResult, Target, TextResult, View } from "../types";
import { editId } from "../geometry";
import { AsyncQueue } from "./async-queue";
import { EngineError, type Engine } from "./engine";
import { InlineClient } from "./inline-client";
import { WorkerClient, type EngineClient } from "./worker-client";

interface Helper {
  client: EngineClient;
  ready: boolean;
  source: string | null;
  version: number;
  wanted: string | null;
}

export interface WasmEngineOptions {
  workers?: number;
}

export function defaultWorkerCount(): number {
  return Math.max(1, Math.min((navigator.hardwareConcurrency || 2) - 1, 6));
}

export class WasmEngine implements Engine {
  readonly kind = "wasm";
  private readonly module: WebAssembly.Module;
  private readonly primary: EngineClient;
  private readonly size: number;
  private helpers: Helper[] = [];
  private helpersStarted = false;
  private view: View | null = null;
  private listeners = new Set<(view: View) => void>();
  private cache = new Map<string, Candidate>();
  private onPrimary = new Map<string, Promise<Candidate>>();

  private constructor(module: WebAssembly.Module, size: number, primary: EngineClient) {
    this.module = module;
    this.size = size;
    this.primary = primary;
  }

  static async create(module: WebAssembly.Module, options: WasmEngineOptions = {}): Promise<WasmEngine> {
    const worker = new WorkerClient(module);
    try {
      await worker.ready;
      return new WasmEngine(module, Math.max(1, options.workers ?? defaultWorkerCount()), worker);
    } catch {
      worker.terminate();
      const inline = new InlineClient(module);
      await inline.ready;
      return new WasmEngine(module, 1, inline);
    }
  }

  get workerCount(): number {
    return this.size;
  }

  get readyHelpers(): number {
    return this.helpers.filter((h) => h.ready).length;
  }

  async current(): Promise<View | null> {
    return this.view;
  }

  subscribe(listener: (view: View) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private adopt(view: View): View {
    this.view = view;
    if (!view.error) {
      this.cache.clear();
      this.onPrimary.clear();
      this.syncHelpers();
    }
    return view;
  }

  private syncHelpers(): void {
    if (!this.helpersStarted) {
      this.helpersStarted = true;
      for (let i = 1; i < this.size; i++) {
        const helper: Helper = { client: new WorkerClient(this.module), ready: false, source: null, version: 0, wanted: null };
        this.helpers.push(helper);
        void helper.client.ready.then(() => this.syncOne(helper));
      }
      return;
    }
    for (const helper of this.helpers) this.syncOne(helper);
  }

  private syncOne(helper: Helper): void {
    const source = this.view?.source;
    if (source === undefined || helper.wanted === source) return;
    helper.wanted = source;
    helper.ready = false;
    helper.client.call<View>("open", source).then(
      (view) => {
        if (helper.wanted !== source) return;
        helper.source = source;
        helper.version = view.version;
        helper.ready = true;
      },
      () => {
        if (helper.wanted === source) helper.wanted = null;
      },
    );
  }

  async open(source: string): Promise<View> {
    const view = this.adopt(await this.primary.call<View>("open", source));
    for (const listener of this.listeners) listener(view);
    return view;
  }

  async reload(source: string): Promise<View> {
    const view = this.adopt(await this.primary.call<View>("reload", source));
    for (const listener of this.listeners) listener(view);
    return view;
  }

  async *preview(target: Target, at: Point, version: number, signal: AbortSignal): AsyncGenerator<PreviewMessage> {
    const started = performance.now();
    const edits = await this.primary.call<Edit[]>("plan", JSON.stringify(target), JSON.stringify(at), version);
    const view = this.view;
    if (!view || signal.aborted) return;
    const queue = [...edits];
    const out = new AsyncQueue<PreviewMessage>();
    const helpers = this.helpers.filter((h) => h.ready && h.source === view.source);
    const runners: { call: (edit: Edit) => Promise<Candidate>; valid: () => boolean }[] =
      helpers.length > 0
        ? helpers.map((h) => ({
            call: (edit) => h.client.call<Candidate>("candidate", JSON.stringify(edit), h.version),
            valid: () => h.ready && h.source === view.source,
          }))
        : [{ call: (edit) => this.build(edit, view.version), valid: () => true }];
    let active = runners.length;
    let count = 0;
    const finish = () => {
      if (--active > 0) return;
      out.push({ done: true, count, ms: performance.now() - started });
      out.close();
    };
    for (const runner of runners) {
      void (async () => {
        while (!signal.aborted && this.view === view && runner.valid()) {
          const edit = queue.shift();
          if (!edit) break;
          const key = editId(edit);
          let candidate = this.cache.get(key);
          if (!candidate) {
            try {
              candidate = await runner.call(edit);
            } catch {
              continue;
            }
            if (this.view === view) this.cache.set(key, candidate);
          }
          if (signal.aborted) break;
          count++;
          out.push({ candidate });
        }
        finish();
      })();
    }
    for await (const message of out) {
      if (signal.aborted) return;
      yield message;
    }
  }

  private build(edit: Edit, version: number): Promise<Candidate> {
    const key = editId(edit);
    const running = this.onPrimary.get(key);
    if (running) return running;
    const task = this.primary.call<Candidate>("candidate", JSON.stringify(edit), version);
    this.onPrimary.set(key, task);
    task.then(
      (candidate) => {
        if (this.onPrimary.get(key) === task) this.cache.set(key, candidate);
      },
      () => {
        if (this.onPrimary.get(key) === task) this.onPrimary.delete(key);
      },
    );
    return task;
  }

  candidate(edit: Edit, version: number, signal: AbortSignal): Promise<Candidate> {
    if (signal.aborted) return Promise.reject(new EngineError("aborted"));
    return this.build(edit, version);
  }

  async route(target: Target, delta: Point, version: number, signal: AbortSignal): Promise<RouteResult> {
    if (signal.aborted) throw new EngineError("aborted");
    return this.primary.call<RouteResult>("route", JSON.stringify(target), JSON.stringify(delta), version);
  }

  async commit(edit: Edit, version: number): Promise<View> {
    return this.adopt(await this.primary.call<View>("commit", JSON.stringify(edit), version));
  }

  async undo(): Promise<View> {
    return this.adopt(await this.primary.call<View>("undo"));
  }

  async redo(): Promise<View> {
    return this.adopt(await this.primary.call<View>("redo"));
  }

  text(unicode: boolean): Promise<TextResult> {
    return this.primary.call<TextResult>("text", unicode);
  }

  exportSvg(dark: boolean): Promise<string> {
    return this.primary.call<string>("exportSvg", dark);
  }
}
