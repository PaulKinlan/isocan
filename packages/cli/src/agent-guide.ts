import guideText from "./agent-guide.md";

/**
 * The collaboration guide agents read before they act — the protocol behind
 * the commands, as opposed to `--help`, which is the commands themselves.
 *
 * It lives HERE, next to the CLI it describes, and not in the skill (#75).
 * The skill is installed once into a directory and then sits there: an agent
 * following a six-month-old copy is being told about a six-month-old CLI, and
 * nothing in the loop notices. Shipping the guide with the binary makes the
 * two impossible to separate — upgrade the CLI and you have upgraded the
 * instructions. `.agents/skills/isocan-collab/SKILL.md` is now a doorway that
 * says "run `isocan --agent-help`", which is small enough to never rot.
 *
 * **Imported as text, not read off disk** (`docs/projects/first-minute`). The
 * release CLI is one bundled file, where `new URL("./agent-guide.md",
 * import.meta.url)` points at a directory that does not exist; the import is a
 * build-time constant instead, inlined by esbuild's text loader and by
 * `bin/workspace-loader.mjs` in source mode. There used to be an
 * `agentGuidePath()` beside this, exported and called by nothing — it went
 * with the disk read.
 */

/**
 * The base guide, then a section per loaded module
 * (`docs/projects/modules/design.md`): a module's verbs are described only
 * while the module is here to answer them, which is `surface.test.ts`'s rule
 * — a verb nobody is told about does not exist — with its pleasant inverse.
 */
export const agentGuide = (moduleSections: readonly string[] = []): string =>
  [guideText, ...moduleSections.map((s) => s.trim())].join("\n\n") + "\n";
