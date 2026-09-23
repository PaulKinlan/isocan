import { moduleBase, type ModuleTool } from "./modules.ts";

/**
 * **What a module may ship that is not code** (proposed: `assets`, 11 Sep
 * 2026 — `docs/projects/design-competition/module-gaps.md` §1).
 *
 * Everybody who loads a module downloads what it shows, the way everybody on a
 * canvas downloads its ground forever, so an asset has a bound for the same
 * reason a ground does (`GROUND_MAX_BYTES`, 2 MB). A module's files are
 * smaller than a picture of a room: an avatar, a `DESIGN.md`, a stylesheet.
 * The bounds are refused at build (`scripts/module-build.mjs`) and at
 * `isocan module add`, before anybody has downloaded anything.
 */
export const ASSET_MAX_BYTES = 256 * 1024;
/** And all of a module's files together. */
export const ASSETS_MAX_BYTES = 2 * 1024 * 1024;

/** Refusals for a manifest's asset list — empty when it fits. */
export function assetProblems(assets: readonly { path: string; size: number }[] | undefined): string[] {
  const problems: string[] = [];
  let total = 0;
  for (const a of assets ?? []) {
    total += a.size;
    if (!/^assets\/[^\0]+$/.test(a.path) || a.path.split("/").includes("..")) problems.push(`${a.path} is not inside assets/`);
    if (a.size > ASSET_MAX_BYTES) problems.push(`${a.path} is ${a.size} bytes, over the ${ASSET_MAX_BYTES}-byte bound for one asset`);
  }
  if (total > ASSETS_MAX_BYTES) problems.push(`assets total ${total} bytes, over the ${ASSETS_MAX_BYTES}-byte bound for a module`);
  return problems;
}

/**
 * **Refusals for a manifest's wasm tools** (isocan-ttd) — empty when every
 * tool is well declared. A tool's digest is what binds its bytes at load; its
 * `abi` is the calling convention as data, checked for SHAPE here — the
 * family's meaning is the caller's, and a family nobody drives is refused by
 * the caller, not guessed at by the manifest.
 */
export function toolProblems(tools: readonly ModuleTool[] | undefined): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const t of tools ?? []) {
    const label = t?.id ?? "(unnamed)";
    if (!/^[a-z0-9-]+$/.test(t?.id ?? "")) problems.push(`tool '${label}' has an id that is not /^[a-z0-9-]+$/`);
    if (seen.has(t?.id)) problems.push(`tool '${label}' is declared twice`);
    seen.add(t?.id);
    if (!/^assets\/[^\0]+$/.test(t?.wasm ?? "") || (t?.wasm ?? "").split("/").includes("..")) problems.push(`tool '${label}' wasm '${t?.wasm}' is not inside assets/`);
    if (!/^[0-9a-f]{64}$/.test(t?.digest ?? "")) problems.push(`tool '${label}' has no 64-hex digest — a module nobody can verify is a module nobody admitted`);
    if (t?.bytes !== undefined && (!Number.isInteger(t.bytes) || t.bytes < 0)) problems.push(`tool '${label}' has bytes ${t.bytes} — the pinned size is a non-negative integer`);
    if (t?.abi !== undefined) {
      if (typeof t.abi.family !== "string" || t.abi.family.length === 0) problems.push(`tool '${label}' declares an abi with no family name`);
      for (const [field, value] of [["input.addr", t.abi.input?.addr], ["input.maxBytes", t.abi.input?.maxBytes], ["output.addr", t.abi.output?.addr], ["output.bytes", t.abi.output?.bytes]] as const) {
        if (!Number.isInteger(value) || (value as number) < 0) problems.push(`tool '${label}' abi ${field} is ${value} — the ABI is data, declared exactly`);
      }
      if (typeof t.abi.call?.export !== "string" || t.abi.call.export.length === 0) problems.push(`tool '${label}' abi names no export to call`);
    }
  }
  return problems;
}

/**
 * A path a module named, resolved against where that module's files are — or
 * null when the module reaches its own files itself (every build-time module,
 * through `new URL("../assets/…", import.meta.url)`) and so has registered no
 * base. The one place a contribution's relative path meets a URL or a
 * directory, so the web and the CLI resolve it the same way.
 */
export function moduleAsset(moduleName: string, relative: string): string | null {
  const base = moduleBase(moduleName);
  if (!base) return null;
  const clean = relative.replace(/^\.?\//, "");
  if (clean.split("/").includes("..")) return null;
  return base + clean;
}
