#!/usr/bin/env node
import { register } from "tsx/esm/api";
import { register as registerLoader } from "node:module";
register();
registerLoader("../../cli/bin/workspace-loader.mjs", import.meta.url);
const { runVoiceCli } = await import("../src/cli.ts");
try { await runVoiceCli(); }
catch (error) { console.error(error instanceof Error ? error.message : "Voice demo failed"); process.exitCode = 1; }
