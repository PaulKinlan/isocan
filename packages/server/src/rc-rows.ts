import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RcAgentRow } from "@isocan/rc";

/**
 * **The enrolment record's rc half, as a file** (agents-on-demand phase 2).
 *
 * The record splits along custody: the home half — which agents answer on a
 * canvas, and their rules — lives in canvas state (`agent.enroll` /
 * `agent.withdraw` ops), because everything that must see it reads canvas
 * state. This half is what running the agent needs — harness, working
 * directory, session handle — and it is a machine fact: only this machine can
 * honor a `cwd`, so it lives in a machine-local file and never replicates, the
 * same split `binding.ts` draws for files ("where a file belongs is a canvas
 * fact; whether it is written is a fact about one machine").
 *
 * It lived in `packages/cli/src/rc.ts` while the CLI was the only thing that
 * read or wrote it. It does not live there any more, for the reason
 * `binding.ts` gives for its own move: **the voice agent reads and writes these
 * rows too** — a claim made at the microphone enrols the actor and records the
 * row, and a rename moves the label — and a second writer of a locked file is
 * two implementations of one rule waiting to disagree. So the primitives sit
 * beside the filesystem, the CLI and the agent both call them, and the file's
 * format is stated once.
 *
 * One file for the whole machine rather than one per rc, because the verbs that
 * write it (`isocan agent add`, `isocan rc add`, a claim from the page) run
 * wherever the caller stands, and an rc reads the rows for its own canvas and
 * no others.
 */

/** The file the whole machine's rows live in, one per (canvas, actor). Named
 * rather than inlined because the lock and the temporary file are its
 * neighbours and have to agree with it. */
export const rcAgentsFile = (home: string) => path.join(home, "rc-agents.json");

/** Every row this machine keeps: which agents answer on which canvas, how to
 * start each one, and where it runs. An absent or unreadable file is "no rows"
 * rather than an error — a machine that has never enrolled an agent is a
 * normal machine, and a reader is never the wrong party here. */
export async function readRcAgents(home: string): Promise<RcAgentRow[]> {
  try {
    return JSON.parse(await fs.readFile(rcAgentsFile(home), "utf8")) as RcAgentRow[];
  } catch {
    return [];
  }
}

/** Serialize every local read/modify/write across CLI, voice agent and parked
 * rc processes. Atomic replacement also keeps readers from observing a
 * half-written JSON file. A crashed writer leaves a visible lock rather than
 * silently risking lost rows. */
export async function updateRcAgents<T>(home: string, change: (rows: RcAgentRow[]) => T): Promise<T> {
  await fs.mkdir(home, { recursive: true });
  const lock = `${rcAgentsFile(home)}.lock`;
  const until = Date.now() + 5000;
  for (;;) {
    try { await fs.symlink(String(process.pid), lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= until) throw new Error(`rc agent records are busy: ${lock}. If its writer has exited, remove that lock and retry.`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const temporary = `${rcAgentsFile(home)}.${randomUUID()}.tmp`;
  try {
    const rows = await readRcAgents(home);
    const result = change(rows);
    await fs.writeFile(temporary, `${JSON.stringify(rows, null, 2)}\n`);
    await fs.rename(temporary, rcAgentsFile(home));
    return result;
  } finally {
    await fs.rm(temporary, { force: true });
    await fs.unlink(lock);
  }
}

/** The row for (canvasId, actorId) replaced in place, or appended when it is
 * new — the one write shape every verb in this file has, so the key a row is
 * filed under is stated once. */
export function replaceRow(rows: RcAgentRow[], row: RcAgentRow): void {
  const index = rows.findIndex((r) => r.canvasId === row.canvasId && r.actorId === row.actorId);
  if (index < 0) rows.push(row);
  else rows[index] = row;
}

/** Add or update the row for (canvasId, actorId) — re-enrolment updates. */
export async function upsertRcAgent(home: string, row: RcAgentRow): Promise<void> {
  await updateRcAgents(home, (rows) => {
    const next = { ...row };
    delete next.preparationId;
    replaceRow(rows, next);
  });
}
