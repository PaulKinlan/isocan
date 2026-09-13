#!/usr/bin/env node
/**
 * **The capability sweep, as a thing that can be re-run.**
 *
 * Paul: "make sure you are not missing all the options like this." A hand-written
 * list is the failure mode — three capabilities were absent from a list
 * described as complete. So the source lists are read from the project itself
 * (`ops.ts`, `isocan --help`, `--agent-help`, the MCP server, the web app, and
 * the harness's own `LIVE_TOOLS`) and every row carries exactly one status
 * token: `tooled`, `missing`, or `excluded` (always with a reason). The counts
 * at the top are computed from those tokens, never typed by hand.
 *
 *   node scripts/voice-capability-sweep.mjs          > writes the doc and the page's data
 *   node scripts/voice-capability-sweep.mjs --check   > fails if either is stale
 *
 * Two outputs, one set of rows. The second is what the help dialog renders
 * (`packages/web/src/voice/capabilities.generated.ts`): a hand-written help
 * section drifts from the harness within a week and starts promising things it
 * cannot do, so the dialog reads the same rows the doc is written from, and
 * `packages/web/test/voicehelp.test.ts` fails when the two disagree.
 *
 * Six sources, not five: the harness's own `LIVE_TOOLS` declarations are the
 * statement that matters most to a person reading the help dialog (memory,
 * files, and the canvas acts the model can actually call), and they were the
 * one list nobody had merged in. Their NAMES are read out of the source, so a
 * tool added there appears in the dialog without anyone editing it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docPath = path.join(root, "docs/projects/voice-harness/capability-sweep.md");
const pagePath = path.join(root, "packages/web/src/voice/capabilities.generated.ts");

/** Every engine operation, in the order `ops.ts` declares them. */
const OPERATIONS = [
  ["actor.claim", "—", "missing", "planned `actor_claim`; an agent re-identifying itself by voice needs the operator's name, not the model's"],
  ["actor.setColor", "`actor_set_color`", "tooled", ""],
  ["actor.setMark", "`actor_set_mark`", "tooled", ""],
  ["actor.join", "`actor_join`", "tooled", "only when the person names the other actor"],
  ["project.create", "—", "missing", "planned `project_create`"],
  ["project.update", "—", "missing", "planned `project_update`"],
  ["project.delete", "—", "excluded", "confirmation-gated; a canvas is not deleted unattended"],
  ["item.add", "`add_item` (`url` → text/uri-list)", "tooled", ""],
  ["item.react", "`item_react`", "tooled", ""],
  ["item.move", "`move_item`, `items_move`", "tooled", ""],
  ["item.resize", "`resize_item`", "tooled", ""],
  ["item.update", "`update_item` / `rename_item`", "tooled", ""],
  ["item.addVersion", "`item_add_version`", "tooled", ""],
  ["item.setCurrentVersion", "`item_set_current_version`", "tooled", ""],
  ["item.removeVersion", "—", "excluded", "internal: the engine refuses it from clients (INTERNAL_OP_TYPES); it is addVersion's undo inverse"],
  ["item.restoreVersion", "—", "excluded", "internal: same set — removeVersion's inverse"],
  ["item.delete", "`delete_item`", "tooled", ""],
  ["item.restore", "`restore_item`", "tooled", ""],
  ["items.move", "`items_move`", "tooled", ""],
  ["items.delete", "`items_delete`", "tooled", ""],
  ["items.restore", "`items_restore`", "tooled", ""],
  ["trash.empty", "—", "excluded", "confirmation-gated; purge is not an unattended act"],
  ["thread.create", "`thread_create`, `comment_on_item`", "tooled", "the log used to name a phantom `item.comment`"],
  ["thread.reply", "`say`, `ask`", "tooled", ""],
  ["thread.setAnchor", "`thread_set_anchor`", "tooled", ""],
  ["thread.setMain", "`thread_set_main`", "tooled", ""],
  ["thread.delete", "`thread_delete`", "tooled", "`isocan comment rm` deletes the thread, not one comment"],
  ["comment.update", "`comment_update`", "tooled", ""],
  ["comment.remove", "—", "excluded", "internal: the engine refuses it from clients; removing a comment is deleting its thread"],
  ["comment.restore", "—", "excluded", "internal: comment.remove's undo inverse"],
  ["thread.restore", "—", "excluded", "internal: thread.delete's undo inverse"],
  ["agent.enroll", "`agent_enroll`", "tooled", ""],
  ["agent.withdraw", "`agent_withdraw`", "tooled", ""],
];

/** The CLI's `Commands:` block, capability by capability. One status each. */
const CLI = [
  ["add note / card / item", "content into an item", "`add_item`", "tooled"],
  ["add --as site / browse", "project a live web page", "`add_item` with `url`", "tooled"],
  ["add --as file/doc/canvas", "other content kinds", "—", "missing"],
  ["add --in / --cell / --prop / --visual", "placement and properties", "—", "missing"],
  ["edit", "edit an item's content in place", "—", "missing"],
  ["set title / description", "metadata", "`update_item`", "tooled"],
  ["set properties / size / file / visual", "metadata and content", "—", "missing"],
  ["rm / restore", "soft delete and restore", "`delete_item`, `restore_item`", "tooled"],
  ["mv (by/absolute)", "move one or many", "`move_item`, `items_move`", "tooled"],
  ["mv --in / --cell", "move into a group or cell", "—", "missing"],
  ["react", "emoji mark", "`item_react`", "tooled"],
  ["react --who / --at", "vote dots by actor or point", "—", "missing"],
  ["comment add", "a comment on an item", "`comment_on_item`", "tooled"],
  ["comment reply", "reply in a thread", "`say`, `ask`", "tooled"],
  ["comment list", "read threads", "`read_threads`", "tooled"],
  ["comment anchor", "anchor a thread", "—", "missing"],
  ["comment main", "designate the Chat thread", "—", "missing"],
  ["comment edit / rm", "edit a comment; rm deletes the thread", "`comment_update`, `thread_delete`", "tooled"],
  ["notify", "say something in the Chat", "—", "missing"],
  ["ask", "ask in the Chat", "`ask`", "tooled"],
  ["who / whoami", "presence and self", "`read_presence`", "tooled"],
  ["session start/on/end/work", "presence control", "—", "missing"],
  ["session select/move/point", "selection and viewport", "`selection_set`, `viewport_pan`, `viewport_focus`", "tooled"],
  ["session say", "speak in the Chat", "`say`", "tooled"],
  ["wait", "park until operations or items change", "—", "excluded — a voice turn ends when the person stops talking; parking belongs to a summoned agent"],
  ["ls", "list items", "`read_canvas`", "tooled"],
  ["get / show", "read one item", "`read_item`", "tooled"],
  ["versions", "the version stack", "`read_item`", "tooled"],
  ["version promote", "switch the current version", "`item_set_current_version`", "tooled"],
  ["trash list", "trashed items", "`restore_item` candidates", "tooled"],
  ["trash restore", "restore from trash", "`restore_item`, `items_restore`", "tooled"],
  ["trash empty", "purge", "—", "excluded — confirmation-gated"],
  ["undo / redo", "history", "—", "excluded — history belongs to the operator; the agent issues a new operation instead"],
  ["open / pass / embed", "entry and one-use passes", "—", "excluded — credentials and entry are the operator's"],
  ["share / space / group / badges", "permissions and identity surfaces", "—", "excluded — access control is operator-only"],
  ["canvas create / edit", "project metadata", "—", "missing"],
  ["canvas list / show", "project reads", "`read_canvas` for the bound canvas", "tooled"],
  ["canvas background / archive / delete", "project presentation and lifecycle", "—", "excluded — archival and deletion are operator acts"],
  ["area", "section sheets", "—", "missing"],
  ["align / fit / distribute / tidy / merge", "layout", "—", "missing"],
  ["drawing (add --drawing)", "pen", "`drawing_add`", "tooled"],
  ["text / docs / sticker / gdoc", "other content families", "—", "missing"],
  ["slides / present", "presentation", "—", "missing"],
  ["export / import / save / teleport", "transfer", "—", "missing"],
  ["map / tree", "structure reads", "—", "excluded — no voice act; `read_canvas` answers the question"],
  ["inline / copy / blobs", "byte-level helpers", "—", "excluded — machine helpers, not canvas acts"],
  ["identity", "who this machine is", "—", "excluded — the harness's enrolled actor is its identity; identity is set before the microphone opens"],
  ["serve / status / restart / stop / upgrade / setup / clone / use / home / direct / mcp / gc / harness / voice / rc / agent add-remove", "machine and daemon administration", "—", "excluded — operator infrastructure, not a canvas capability"],
  ["prefer / choose / persona", "identity and routing preferences", "—", "excluded — operator configuration"],
  ["inbox / doc / context", "the operator's own surfaces", "—", "excluded — inbox and configuration belong to the person; AGENTS.md is already loaded into the model's instruction"],
  ["sprint / design / evals / whatsnew / recap / timeline / lens / history / tail / activity / at / shortcuts / tool / command / module", "workflow, reporting and read surfaces", "—", "excluded — none of them is a canvas mutation; the ones a voice agent needs (`read_activity`) are listed in the agent-guide table"],
  ["help", "the guide itself", "—", "excluded — the model already has the system instruction and the tool declarations"],
];

const AGENT = [
  ["Read the canvas", "`read_canvas`", "tooled"],
  ["Read one item and its versions", "`read_item`", "tooled"],
  ["Read threads and comments", "`read_threads`", "tooled"],
  ["Read presence", "`read_presence`", "tooled"],
  ["Read activity / history", "—", "missing"],
  ["Find items", "`find_items`", "tooled"],
  ["Add content", "`add_item`", "tooled"],
  ["Edit content", "—", "missing"],
  ["Delete and restore", "`delete_item`, `restore_item`", "tooled"],
  ["Comment, reply, ask", "`comment_on_item`, `say`, `ask`", "tooled"],
  ["Anchor a thread / set the main thread", "—", "missing"],
  ["React", "`item_react`", "tooled"],
  ["Draw", "`drawing_add`", "tooled"],
  ["Move, resize, multi-select move", "`move_item`, `resize_item`, `items_move`", "tooled"],
  ["Select and clear selection", "`selection_set`, `selection_clear`", "tooled"],
  ["Point the viewport", "`viewport_focus`, `viewport_pan`", "tooled"],
  ["Presence control (start / on / end / work)", "—", "missing"],
  ["Wait for another agent", "—", "excluded — parking belongs to the summoned agent, not the microphone"],
  ["Summon an agent (`rc turn`)", "—", "excluded — a machine-side act, on another host"],
  ["Enrol / withdraw an agent", "`agent_enroll`, `agent_withdraw`", "tooled"],
  ["Identity (`--as`, `--session`)", "—", "excluded — the harness's enrolled actor is its identity"],
];

const MCP = [
  ["list_canvases", "—", "missing"],
  ["read_canvas", "`read_canvas`", "tooled"],
  ["read_item", "`read_item`", "tooled"],
  ["read_threads", "`read_threads`", "tooled"],
  ["read_activity", "—", "missing"],
  ["who", "`read_presence`", "tooled"],
];

const WEB = [
  ["Type and edit text in place", "—", "missing"],
  ["Drag items", "`move_item`", "tooled"],
  ["Resize by handle", "`resize_item`", "tooled"],
  ["Multi-select and move", "`items_move`", "tooled"],
  ["Create notes and cards", "`add_item`", "tooled"],
  ["Paste a URL as a live page", "`add_item` with `url`", "tooled"],
  ["Draw with the pen", "`drawing_add`", "tooled"],
  ["Switch versions", "`item_set_current_version`", "tooled"],
  ["Create a version", "`item_add_version`", "tooled"],
  ["Remove / restore a version", "—", "excluded — internal ops; the engine refuses them from clients"],
  ["Delete to trash / restore", "`delete_item`, `restore_item`", "tooled"],
  ["Permanent trash purge", "—", "excluded — confirmation-gated"],
  ["Comment on an item", "`comment_on_item`", "tooled"],
  ["Edit / remove a comment", "`comment_update`; removal is thread.delete", "tooled"],
  ["Anchor a thread by dragging its pin", "`thread_set_anchor`", "tooled"],
  ["Reply in the Chat", "`say`, `ask`; `notify` missing", "tooled"],
  ["React with an emoji", "`item_react`", "tooled"],
  ["Vote dot at a point", "—", "missing"],
  ["Zoom / pan the viewport", "`viewport_pan`", "tooled"],
  ["Focus an item in someone's view", "`viewport_focus`", "tooled"],
  ["Selection", "`selection_set`, `selection_clear`", "tooled"],
  ["Change your own colour / mark", "`actor_set_color`, `actor_set_mark`", "tooled"],
  ["See presence", "`read_presence`", "tooled"],
  ["Share links and permissions", "—", "excluded — operator-only"],
  ["Present / slides / deck", "—", "missing"],
  ["Areas / sections", "—", "missing"],
  ["Align / distribute / tidy / fit", "—", "missing"],
  ["Merge items", "—", "missing"],
  ["Import / export", "—", "missing"],
  ["Google Docs", "—", "missing"],
  ["Background / ground / theme", "—", "excluded — taste, and the person is looking at it"],
  ["Archive a canvas", "—", "missing"],
  ["Undo / redo", "—", "excluded — history belongs to the operator"],
];

/**
 * **The harness's own tools, read out of the declaration rather than retyped.**
 *
 * The sentence beside each one is for the help dialog: `item_add_version` is
 * not a thing a person asks for, "keep this text as a version" is. A tool with
 * no sentence still gets a row, under its own name — the list is the source,
 * the wording is not — so a tool added to `LIVE_TOOLS` cannot go missing from
 * the dialog without failing the sweep's own test.
 */
function harnessToolNames() {
  const src = readFileSync(path.join(root, "packages/cli/src/voice-harness.ts"), "utf8");
  const from = src.indexOf("export const LIVE_TOOLS");
  const to = src.indexOf("export async function resolveProjectInstructions");
  if (from < 0 || to < from) throw new Error("LIVE_TOOLS not found in packages/cli/src/voice-harness.ts");
  return [...src.slice(from, to).matchAll(/^\s{4}name: "([a-z_]+)",/gm)].map((m) => m[1]);
}

const HARNESS_SAYS = {
  read_canvas: "Read the canvas",
  read_item: "Read one item, and its versions",
  read_threads: "Read threads and comments",
  read_presence: "See who is live on the canvas",
  find_items: "Find items by what they say",
  add_item: "Add a note, a card, a link or an image",
  drawing_add: "Draw ink on the canvas",
  update_item: "Change an item's text, title or description",
  rename_item: "Rename an item",
  item_add_version: "Keep an item's text as a new version",
  item_set_current_version: "Switch an item to another version",
  item_react: "React to an item with an emoji",
  move_item: "Move an item",
  resize_item: "Resize an item",
  items_move: "Move several items at once",
  selection_set: "Select items",
  selection_clear: "Clear the selection",
  viewport_focus: "Bring an item into somebody's view",
  viewport_pan: "Pan the view",
  delete_item: "Move an item to the trash",
  restore_item: "Bring an item back from the trash",
  items_delete: "Move several items to the trash",
  items_restore: "Bring several items back",
  say: "Say something in the Chat",
  ask: "Ask a question in the Chat and wait for an answer",
  notify: "Post in the Chat without waiting for an answer",
  comment_on_item: "Leave a comment on an item",
  comment_update: "Edit a comment",
  thread_create: "Start a thread on an item",
  thread_set_anchor: "Pin a thread to a point on the canvas",
  thread_set_main: "Make a thread the canvas's main Chat",
  thread_delete: "Delete a thread and its comments",
  actor_set_color: "Change the colour of its own presence",
  actor_set_mark: "Change the emoji on its own presence",
  actor_join: "Fold another of this machine's identities into itself",
  agent_enroll: "Enrol another agent so it can be summoned by name",
  agent_withdraw: "Withdraw an enrolled agent",
  remember: "Remember a fact for a later session",
  read_memory: "Read one stored memory",
  search_memory: "Search its memories",
  list_dir: "List the folder you granted",
  read_file: "Read one file from the folder you granted",
};

/** `[capability, tool, status]`, like the agent guide's table. */
const HARNESS = harnessToolNames().map((name) => [HARNESS_SAYS[name] ?? name, `\`${name}\``, "tooled"]);

const rows = [];
const add = (source, capability, tool, status, note = "") => rows.push({ source, capability, tool, status, note });

for (const [op, tool, status, note] of OPERATIONS) add("reducer", op, tool, status, note);
for (const [capability, _x, tool, status] of CLI) add("cli", capability, tool, status);
for (const [capability, tool, status] of AGENT) add("agent-help", capability, tool, status);
for (const [capability, tool, status] of MCP) add("mcp", capability, tool, status);
for (const [capability, tool, status] of WEB) add("web", capability, tool, status);
for (const [capability, tool, status] of HARNESS) add("harness", capability, tool, status);

/** Statuses are exact tokens; anything after " — " is the reason, kept apart
 * from the token so the counts cannot silently miss a row. */
const base = (status) => String(status).split(" — ")[0];
const why = (status) => String(status).split(" — ").slice(1).join(" — ");
const count = (status) => rows.filter((r) => base(r.status) === status).length;
const total = rows.length;

/* ------------------------------------------------------------------ *
 * The help dialog's section, from the same rows
 * ------------------------------------------------------------------ */

/**
 * **A person does not ask for `item_add_version`.**
 *
 * Tooled rows are grouped by the act a person would ask for and deduped by
 * tool, so `add_item` appears once rather than eight times under five
 * surfaces. The grouping is total: anything the rules do not name lands in the
 * last group under its own name, which is how a new capability reaches the
 * dialog without anybody remembering to edit the page.
 */
const GROUP_RULES = [
  [/^(remember|read_memory|search_memory)$/, "Remember things for later"],
  [/^(list_dir|read_file)$/, "Files in the folder you granted"],
  [/^(read_canvas|read_item|read_threads|read_presence|find_items)$/, "Find and read what is there"],
  [/^(add_item|drawing_add)$/, "Put things on the canvas"],
  [/^(update_item|rename_item|item_add_version|item_set_current_version|item_react)$/, "Change what is already there"],
  [/^(move_item|resize_item|items_move|selection_set|selection_clear|viewport_focus|viewport_pan)$/, "Move, resize and point the view"],
  [/^(delete_item|restore_item|items_delete|items_restore)$/, "Remove, and bring back"],
  [/^(say|ask|notify|comment_on_item|comment_update|thread_create|thread_set_anchor|thread_set_main|thread_delete)$/, "Talk on the canvas"],
  [/^(actor_set_color|actor_set_mark|actor_join|agent_enroll|agent_withdraw)$/, "Identity and other agents"],
];
const OTHER_GROUP = "Also available";
/** Which source's wording reads best to a person: the dialog is the harness's. */
const SOURCE_PREFERENCE = ["harness", "web", "agent-help", "cli", "reducer"];

/** The FIRST name a row names is the tool the row is about; the rest are the
 * siblings it also mentions (`\`move_item\`, `\`items_move\``). Taking every
 * backticked word would make `add_item` with `url` into a tool called `url`. */
const toolOf = (tool) => String(tool).match(/`([^`]+)`/)?.[1] ?? null;
const byTool = new Map();
for (const row of rows.filter((r) => base(r.status) === "tooled")) {
  const name = toolOf(row.tool) ?? (row.tool === "—" ? null : row.capability);
  if (name) byTool.set(name, [...(byTool.get(name) ?? []), row]);
}
const labelFor = (list) =>
  (SOURCE_PREFERENCE.map((s) => list.find((r) => r.source === s)).find(Boolean) ?? list[0]).capability;

const groups = [...GROUP_RULES.map(([, title]) => title), OTHER_GROUP].map((title) => ({ title, acts: [] }));
for (const [tool, list] of byTool) {
  const group = GROUP_RULES.find(([re]) => re.test(tool))?.[1] ?? OTHER_GROUP;
  groups.find((g) => g.title === group).acts.push({ label: labelFor(list), tool });
}
for (const group of groups) group.acts.sort((a, b) => a.tool.localeCompare(b.tool));

/** What counts as reachable, and what is refused by design — the page's copy. */
const pageModule = `/**
 * GENERATED — do not edit. \`node scripts/voice-capability-sweep.mjs\` writes
 * this from the same rows as docs/projects/voice-harness/capability-sweep.md,
 * and \`--check\` fails when it is stale. The help dialog renders it, and
 * packages/web/test/voicehelp.test.ts fails when the dialog and the sweep
 * disagree — which is the only reason a help section stays true.
 */
export const HELP_COUNTS = ${JSON.stringify(
  { total, tooled: count("tooled"), missing: count("missing"), excluded: count("excluded") },
  null,
  2,
)} as const;
export const HELP_GROUPS = ${JSON.stringify(
  groups.filter((g) => g.acts.length > 0),
  null,
  2,
)} as const;
export const HELP_REFUSED = ${JSON.stringify(
  rows
    .filter((r) => base(r.status) === "excluded")
    .map((r) => ({ label: r.capability, why: [why(r.status), r.note].filter(Boolean).join("; ") })),
  null,
  2,
)} as const;
`;

function table(title, header, body) {
  return `### ${title}\n\n| ${header.join(" | ")} |\n|${header.map(() => "---").join("|")}|\n${body}\n`;
}

const line = (cap, tool, status, note) => `| ${cap} | ${tool} | **${base(status)}** | ${[why(status), note].filter(Boolean).join("; ")} |`;
const harnessRows = HARNESS.map(([cap, tool, status]) => line(cap, tool, status)).join("\n");const engineRows = OPERATIONS.map(([op, tool, status, note]) => `| \`${op}\` | ${tool} | **${base(status)}** | ${[why(status), note].filter(Boolean).join("; ")} |`).join("\n");
const cliRows = CLI.map(([cap, , tool, status]) => line(cap, tool, status)).join("\n");
const agentRows = AGENT.map(([cap, tool, status]) => line(cap, tool, status)).join("\n");
const mcpRows = MCP.map(([cap, tool, status]) => line(cap, tool, status)).join("\n");
const webRows = WEB.map(([cap, tool, status]) => line(cap, tool, status)).join("\n");

const doc = `# Voice Harness: Capability Sweep

**Date:** 2026-09-12
**Status:** generated by \`scripts/voice-capability-sweep.mjs\`; rows are marked \`tooled\`, \`missing\`, or \`excluded\` (with a reason). Counts are computed from the rows.
**Method:** the union of six existing statements of what an agent can do — the engine's operations, the CLI, the agent guide, MCP, the web UI, and the voice harness's own \`LIVE_TOOLS\` declarations. Nothing is hand-picked; run the script to check this file is current. The help dialog's capability section is generated from these same rows (\`packages/web/src/voice/capabilities.generated.ts\`).

## Count line

**${total} capabilities across six sources — ${count("tooled")} tooled, ${count("missing")} missing, ${count("excluded")} excluded with a reason.**

| Source | Rows | tooled | missing | excluded |
|---|---|---|---|---|
| Reducer (\`packages/core/src/ops.ts\`) | ${OPERATIONS.length} | ${OPERATIONS.filter((o) => base(o[2]) === "tooled").length} | ${OPERATIONS.filter((o) => base(o[2]) === "missing").length} | ${OPERATIONS.filter((o) => base(o[2]) === "excluded").length} |
| CLI (\`isocan --help\`) | ${CLI.length} | ${CLI.filter((c) => base(c[3]) === "tooled").length} | ${CLI.filter((c) => base(c[3]) === "missing").length} | ${CLI.filter((c) => base(c[3]) === "excluded").length} |
| Agent guide (\`isocan --agent-help\`) | ${AGENT.length} | ${AGENT.filter((a) => base(a[2]) === "tooled").length} | ${AGENT.filter((a) => base(a[2]) === "missing").length} | ${AGENT.filter((a) => base(a[2]) === "excluded").length} |
| MCP (\`packages/mcp/src/server.ts\`) | ${MCP.length} | ${MCP.filter((m) => base(m[2]) === "tooled").length} | ${MCP.filter((m) => base(m[2]) === "missing").length} | ${MCP.filter((m) => base(m[2]) === "excluded").length} |
| Web UI (\`packages/web\`) | ${WEB.length} | ${WEB.filter((w) => base(w[2]) === "tooled").length} | ${WEB.filter((w) => base(w[2]) === "missing").length} | ${WEB.filter((w) => base(w[2]) === "excluded").length} |
| Voice harness (\`packages/cli/src/voice-harness.ts\`, \`LIVE_TOOLS\`) | ${HARNESS.length} | ${HARNESS.length} | 0 | 0 |

---

## 1. Engine operations — \`packages/core/src/ops.ts\` (${OPERATIONS.length} rows)

${table("Reducer", ["Operation", "Tool", "Status", "Notes"], engineRows)}

## 2. CLI command surface — \`isocan --help\` (${CLI.length} rows)

${table("CLI", ["Capability", "Tool", "Status", "Reason"], cliRows)}

## 3. Agent guide — \`isocan --agent-help\` (${AGENT.length} rows)

${table("Agent surface", ["Capability", "Tool", "Status", "Reason"], agentRows)}

## 4. MCP surface — \`packages/mcp/src/server.ts\` (${MCP.length} rows)

MCP exposes reads only; the voice harness is the write surface.

${table("MCP", ["Capability", "Tool", "Status", "Reason"], mcpRows)}

## 5. Web UI — what a person can do that the agent cannot yet (${WEB.length} rows)

${table("Web", ["Capability", "Tool", "Status", "Reason"], webRows)}

## 6. Voice harness tool declarations — \`packages/cli/src/voice-harness.ts\` (${HARNESS.length} rows)

What the model can actually call, read out of \`LIVE_TOOLS\` rather than retyped. This is the source the help dialog's "what it can do" section is grouped from: the tool names above, in the words a person would use.

${table("Harness", ["Capability", "Tool", "Status", "Reason"], harnessRows)}

## 7. Validation ledger

Every row marked \`tooled\` must have one driven call that mints the expected operation and appears in \`/log\`. \`packages/cli/test/voice-harness.test.ts\` is the harness.

| Family | Test | Status |
|---|---|---|
| Reads: canvas, item, threads, presence, find | \`drives live tools end-to-end…\`, \`exercises Paul's five tools…\` | passing |
| Content: note and web page | \`drives live tools end-to-end…\` | passing |
| Rename / update labels | the label tests in \`what a sentence means\` | passing |
| Move, resize, multi-move | \`exercises Paul's five tools…\` | passing |
| Draw, react, comment, delete | \`exercises Paul's five tools…\` | passing |
| Version switch | same test | passing |
| Typed utterance path | \`handles typed 'add a note' utterances…\` | passing |
| Versions: add / remove / restore | — | missing |
| Threads: anchor / main / delete / restore | — | missing |
| Comments: update / remove / restore | — | missing |
| Identity: colour / mark / join / claim | — | missing |
| Agents: enrol / withdraw | — | missing |
| Projects: create / update | — | missing |
| Presence commands | — | missing |
`;

const check = process.argv.includes("--check");
const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};
const outputs = [
  [docPath, doc],
  [pagePath, pageModule],
];
const summary = `${total} rows, ${count("tooled")} tooled, ${count("missing")} missing, ${count("excluded")} excluded, ${byTool.size} tooled tools in ${groups.filter((g) => g.acts.length).length} groups`;
if (check) {
  const stale = outputs.filter(([file, text]) => read(file) !== text).map(([file]) => path.relative(root, file));
  if (stale.length) {
    console.error(`${stale.join(" and ")} stale — run: node scripts/voice-capability-sweep.mjs`);
    process.exit(1);
  }
  console.log(`capability sweep is current: ${summary}.`);
} else {
  for (const [file, text] of outputs) {
    writeFileSync(file, text);
    console.log(`wrote ${path.relative(root, file)}`);
  }
  console.log(summary);
}
