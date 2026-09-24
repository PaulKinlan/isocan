/**
 * **`WebAssembly`, typed for a package that has no DOM.**
 *
 * `packages/server/tsconfig.json` sets `types: ["node"]`, and the base config
 * keeps `lib` to ES2023. Node's own types do not declare the WebAssembly
 * namespace — only `lib.dom` does — so `WebAssembly.instantiate(…)` does not
 * typecheck here, and neither does `WebAssembly.Instance`. The two ways out
 * are both worse than this file: adding the DOM to a daemon's lib is how
 * `document` starts typechecking in code that has no document, and casting at
 * every call site is the same cast written several times and free to drift.
 *
 * So the three things this package actually uses are named once, here. The
 * shapes are the platform's, deliberately minimal: the host reads only
 * `exports` and `memory.buffer`. The VALUE is taken off `globalThis` because
 * that is where the engine puts it; nothing here reimplements it.
 */
interface WasmExports {
  readonly [name: string]: unknown;
}

/** A loaded module. Only `exports` is read — the host asks the module for its
 *  own addresses rather than carrying a vendored copy of them. */
export interface WasmInstance {
  readonly exports: WasmExports;
}

/** The module's linear memory, as the host sees it: a buffer that must be
 *  re-read after every call, because a growing module replaces it. */
export interface WasmMemory {
  readonly buffer: ArrayBuffer;
}

export const wasm = (
  globalThis as unknown as {
    WebAssembly: {
      instantiate(
        bytes: Uint8Array,
        imports?: Record<string, unknown>,
      ): Promise<{ instance: WasmInstance; module: unknown }>;
    };
  }
).WebAssembly;
