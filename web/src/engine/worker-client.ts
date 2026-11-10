import { EngineError } from "./engine";

type Outgoing =
  | { type: "ready" }
  | { type: "failed"; error: string }
  | { type: "result"; id: number; ok: true; result: unknown }
  | { type: "result"; id: number; ok: false; error: string };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface EngineClient {
  readonly ready: Promise<void>;
  call<T>(op: keyof D2SquaredApi, ...args: unknown[]): Promise<T>;
  terminate(): void;
}

export class WorkerClient implements EngineClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private next = 1;
  readonly ready: Promise<void>;

  constructor(module: WebAssembly.Module) {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onerror = (event) => reject(new Error(event.message || "worker failed"));
      this.worker.onmessage = (event: MessageEvent<Outgoing>) => {
        const msg = event.data;
        if (msg.type === "ready") {
          resolve();
          return;
        }
        if (msg.type === "failed") {
          reject(new Error(msg.error));
          return;
        }
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new EngineError(msg.error, msg.error === "stale version" ? 409 : 422));
      };
    });
    this.worker.postMessage({ type: "init", module });
  }

  call<T>(op: keyof D2SquaredApi, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.next++;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ type: "call", id, op, args });
    });
  }

  terminate(): void {
    this.worker.terminate();
    for (const entry of this.pending.values()) entry.reject(new Error("worker stopped"));
    this.pending.clear();
  }
}
