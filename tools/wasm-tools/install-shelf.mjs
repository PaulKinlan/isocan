// install-shelf.mjs — install the built wasm-tools module into the daemon's
// home (~/.isocan/modules/wasm-tools), where `isocan module ls` lists it.
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
const src = new URL("./dist/module/wasm-tools", import.meta.url).pathname;
const dest = path.join(process.env.ISOCAN_HOME ?? path.join(homedir(), ".isocan"), "modules", "wasm-tools");
mkdirSync(path.dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(JSON.stringify({ installed: dest, manifest: path.join(dest, "manifest.json"), existed: existsSync(path.join(dest, "manifest.json")) }));
