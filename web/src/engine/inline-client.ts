import { EngineError } from "./engine";
import type { EngineClient } from "./worker-client";

export class InlineClient implements EngineClient {
  readonly ready: Promise<void>;

  constructor(module: WebAssembly.Module) {
    this.ready = this.boot(module);
  }

  private async boot(module: WebAssembly.Module): Promise<void> {
    await import("../wasm_exec.js");
    const go = new Go();
    const instance = await WebAssembly.instantiate(module, go.importObject);
    const ready = new Promise<void>((resolve) => {
      globalThis.d2squaredReady = resolve;
    });
    void go.run(instance);
    await ready;
  }

  async call<T>(op: keyof D2SquaredApi, ...args: unknown[]): Promise<T> {
    await this.ready;
    try {
      const fn = d2squared[op] as (...a: unknown[]) => Promise<string>;
      return JSON.parse(await fn.apply(d2squared, args)) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new EngineError(message, message === "stale version" ? 409 : 422);
    }
  }

  terminate(): void {}
}
