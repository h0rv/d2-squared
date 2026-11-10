declare class Go {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

interface D2SquaredApi {
  open(source: string): Promise<string>;
  reload(source: string): Promise<string>;
  view(): Promise<string>;
  plan(target: string, at: string, version: number): Promise<string>;
  candidate(edit: string, version: number): Promise<string>;
  route(target: string, delta: string, version: number): Promise<string>;
  commit(edit: string, version: number): Promise<string>;
  undo(): Promise<string>;
  redo(): Promise<string>;
  verify(): Promise<string>;
  text(unicode: boolean): Promise<string>;
  exportSvg(dark: boolean): Promise<string>;
}

declare var d2squared: D2SquaredApi;
declare var d2squaredReady: (() => void) | undefined;

declare module "*/wasm_exec.js";
