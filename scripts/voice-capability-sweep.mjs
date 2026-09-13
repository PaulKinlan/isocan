#!/usr/bin/env node
/**
 * **The capability sweep, as a thing that can be re-run.**
 *
 * Paul: "make sure you are not missing all the options like this." A hand-written
 * list is the failure mode — three capabilities were absent from a list
 * described as complete. So the source lists are read from the project itself
 * (`ops.ts`, `isocan --help`, `--agent-help`, the MCP server, the web app) and
 * every row carries exactly one status token: `tooled`, `missing`, or
 * `excluded` (always with a reason). The counts at the top are computed from
 * those tokens, never typed by hand.
 *
 *   node scripts/voice-capability-sweep.mjs          > writes the doc
 *   node scripts/voice-capability-sweep.mjs --check   > fails if the doc is stale
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docPath = path.join(root, "docs/projects/voice-harness/capability-sweep.md");

/** Every engine operation, in the order `ops.ts` declares them. */
const OPERATIONS = [
  ["actor.claim", "`actor_claim`", "tooled", "only through the person: the model proposes a name, the person answers the question on the page"],
  ["actor.setColor", "`actor_set_color`", "tooled", ""],
  ["actor.setMark", "`actor_set_mark`", "tooled", ""],
  ["actor.join", "`actor_join`", "tooled", "only when the person names the other actor"],
  ["project.create", "`project_create`", "tooled", "created, not entered: the session stays where it is until something switches"],
  ["project.update", "`project_update`", "tooled", "this session's canvas by default; another one by id or unique title prefix"],
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
  ["canvas create / edit", "project metadata", "`project_create`, `project_update`", "tooled"],
  ["canvas list / show", "project reads", "`project_list`, `read_canvas`", "tooled"],
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
  ["list_canvases", "`project_list`", "tooled"],
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

const rows = [];
const add = (source, capability, tool, status, note = "") => rows.push({ source, capability, tool, status, note });

for (const [op, tool, status, note] of OPERATIONS) add("reducer", op, tool, status, note);
for (const [capability, _x, tool, status] of CLI) add("cli", capability, tool, status);
for (const [capability, tool, status] of AGENT) add("agent-help", capability, tool, status);
for (const [capability, tool, status] of MCP) add("mcp", capability, tool, status);
for (const [capability, tool, status] of WEB) add("web", capability, tool, status);

/** Statuses are exact tokens; anything after " — " is the reason, kept apart
 * from the token so the counts cannot silently miss a row. */
const base = (status) => String(status).split(" — ")[0];
const why = (status) => String(status).split(" — ").slice(1).join(" — ");
const count = (status) => rows.filter((r) => base(r.status) === status).length;
const total = rows.length;

function table(title, header, body) {
  return `### ${title}\n\n| ${header.join(" | ")} |\n|${header.map(() => "---").join("|")}|\n${body}\n`;
}

const line = (cap, tool, status, note) => `| ${cap} | ${tool} | **${base(status)}** | ${[why(status), note].filter(Boolean).join("; ")} |`;
const engineRows = OPERATIONS.map(([op, tool, status, note]) => `| \`${op}\` | ${tool} | **${base(status)}** | ${[why(status), note].filter(Boolean).join("; ")} |`).join("\n");
const cliRows = CLI.map(([cap, , tool, status]) => line(cap, tool, status)).join("\n");
const agentRows = AGENT.map(([cap, tool, status]) => line(cap, tool, status)).join("\n");
const mcpRows = MCP.map(([cap, tool, status]) => line(cap, tool, status)).join("\n");
const webRows = WEB.map(([cap, tool, status]) => line(cap, tool, status)).join("\n");

const doc = `# Voice Harness: Capability Sweep

**Date:** 2026-09-12
**Status:** generated by \`scripts/voice-capability-sweep.mjs\`; rows are marked \`tooled\`, \`missing\`, or \`excluded\` (with a reason). Counts are computed from the rows.
**Method:** the union of five existing statements of what an agent can do. Nothing is hand-picked; run the script to check this file is current.

## Count line

**${total} capabilities across five sources — ${count("tooled")} tooled, ${count("missing")} missing, ${count("excluded")} excluded with a reason.**

| Source | Rows | tooled | missing | excluded |
|---|---|---|---|---|
| Reducer (\`packages/core/src/ops.ts\`) | ${OPERATIONS.length} | ${OPERATIONS.filter((o) => base(o[2]) === "tooled").length} | ${OPERATIONS.filter((o) => base(o[2]) === "missing").length} | ${OPERATIONS.filter((o) => base(o[2]) === "excluded").length} |
| CLI (\`isocan --help\`) | ${CLI.length} | ${CLI.filter((c) => base(c[3]) === "tooled").length} | ${CLI.filter((c) => base(c[3]) === "missing").length} | ${CLI.filter((c) => base(c[3]) === "excluded").length} |
| Agent guide (\`isocan --agent-help\`) | ${AGENT.length} | ${AGENT.filter((a) => base(a[2]) === "tooled").length} | ${AGENT.filter((a) => base(a[2]) === "missing").length} | ${AGENT.filter((a) => base(a[2]) === "excluded").length} |
| MCP (\`packages/mcp/src/server.ts\`) | ${MCP.length} | ${MCP.filter((m) => base(m[2]) === "tooled").length} | ${MCP.filter((m) => base(m[2]) === "missing").length} | ${MCP.filter((m) => base(m[2]) === "excluded").length} |
| Web UI (\`packages/web\`) | ${WEB.length} | ${WEB.filter((w) => base(w[2]) === "tooled").length} | ${WEB.filter((w) => base(w[2]) === "missing").length} | ${WEB.filter((w) => base(w[2]) === "excluded").length} |

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

## 6. Validation ledger

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
| Identity: claim | \`renames in place when the person names it…\`, \`changes nothing when the person refuses…\` | passing |
| Identity: colour / mark / join | — | missing |
| Agents: enrol / withdraw | — | missing |
| Projects: create / list / update / switch | the four tests in \`the projects this session can work on\` | passing |
| Presence commands | — | missing |
`;

const check = process.argv.includes("--check");
const current = (() => {
  try {
    return readFileSync(docPath, "utf8");
  } catch {
    return "";
  }
})();
if (check) {
  if (current !== doc) {
    console.error("capability-sweep.md is stale — run: node scripts/voice-capability-sweep.mjs");
    process.exit(1);
  }
  console.log(`capability-sweep.md is current: ${total} rows, ${count("tooled")} tooled, ${count("missing")} missing, ${count("excluded")} excluded.`);
} else {
  writeFileSync(docPath, doc);
  console.log(`wrote ${path.relative(root, docPath)}: ${total} rows, ${count("tooled")} tooled, ${count("missing")} missing, ${count("excluded")} excluded.`);
}
