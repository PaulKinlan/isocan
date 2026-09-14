/**
 * **The voice agent, as a command — one entry point, two ways in.**
 *
 * There is deliberately only one of these. A person starts the agent with a
 * command they can remember (`npm start -w @isocan/voice-agent`, or
 * `npx voice-agent`), and `isocan rc` starts *the same file* with `--acp` when
 * a summons arrives. Two entry points would mean two things that had to agree
 * about the port, the home, the identity and the page, and the day they drifted
 * is the day the summons opened a second microphone nobody was talking into.
 *
 * What each mode is:
 *
 * - **no flags — the standing server.** Claims who this microphone is, opens
 *   the page, captures audio, holds the key and the operations. It lives as
 *   long as the person wants it to, which is the point: a microphone is not a
 *   turn.
 * - **`--acp`** — the adapter the rc spawns. It speaks ACP over stdio and hands
 *   a summons to the standing server, starting one detached if none is up. It
 *   prints nothing on stdout but JSON-RPC.
 *
 * This used to be a verb of the CLI (`isocan voice`), and the reason it is not
 * any more is the same reason the page is not a route of the web app: neither
 * the app nor the CLI needs to know how the voice agent works in order to
 * point at it. `isocan rc` points at it, through the harness registry, exactly
 * as it points at pi or Claude Code.
 */
import { connect } from "@isocan/api";
import { readRcAgents } from "./rc-rows.ts";
import {
  DEFAULT_VOICE_PORT,
  VOICE_HARNESS,
  claimVoiceIdentity,
  isocanHome,
  runVoiceAdapter,
  startVoiceServer,
} from "./voice-harness.ts";

export interface VoiceArgs {
  acp: boolean;
  help: boolean;
  /** The agent the microphone speaks as, else the injected session, else Voice. */
  name?: string;
  port?: number;
  /** The Live model for this run; wins over the choice stored by the page. */
  model?: string;
  /** The canvas to send to; else `ISOCAN_CANVAS`, else this directory's. */
  canvas?: string;
}

/** What `--help` prints, and what an unknown flag is refused with — the same
 * list, so the two cannot drift apart. */
export const USAGE = [
  "voice-agent — the isocan voice agent: a harness and the page you talk to",
  "",
  "  voice-agent                     the standing server: page, microphone, operations",
  "  voice-agent --acp               speak ACP on stdio — what `isocan rc` spawns",
  "",
  "  --as <name>                     the agent the microphone speaks as (default:",
  "                                  the injected session, else Voice)",
  `  --port <n>                      the loopback port the page is served on (default ${DEFAULT_VOICE_PORT})`,
  "  --model <name>                  the Gemini Live model this run talks through",
  "  --canvas <ref>                  the canvas to send to (default: this directory's)",
  "",
  "The harness is reached through `isocan rc`: it starts this file with --acp on a",
  "summons, attaches to a standing one if there is one, and starts one if not.",
].join("\n");

/** The flags, spelled once. `--port` and `--voice-port` are the same thing:
 * the detached server and the docs name it differently, and a second spelling
 * is cheaper than a flag that silently does nothing. */
export function parseVoiceArgs(argv: readonly string[]): VoiceArgs {
  const args: VoiceArgs = { acp: false, help: false };
  const need = (i: number, flag: string): string => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--acp") { args.acp = true; continue; }
    if (flag === "--help" || flag === "-h") { args.help = true; continue; }
    if (flag === "--as" || flag === "--name") { args.name = need(i, flag); i++; continue; }
    if (flag === "--port" || flag === "--voice-port") {
      const raw = need(i, flag);
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${flag} needs a port number, got "${raw}"`);
      args.port = port;
      i++;
      continue;
    }
    if (flag === "--model") { args.model = need(i, flag); i++; continue; }
    if (flag === "--canvas") { args.canvas = need(i, flag); i++; continue; }
    throw new Error(`unknown flag "${flag}"\n\n${USAGE}`);
  }
  return args;
}

/**
 * **The standing server, started here rather than through the CLI.**
 *
 * Everything it needs it resolves itself, the way the harness already resolves
 * its own canvas and identity: `connect()` reads the same home, the same
 * daemon and the same ambient session key every other client does, so a
 * harness started by a person and one started by the rc speak as the same
 * collaborator when they are given the same identity.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseVoiceArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const home = isocanHome();
  const name = args.name ?? process.env.ISOCAN_SESSION_ID ?? "Voice";
  const canvas = args.canvas ?? process.env.ISOCAN_CANVAS;
  const say = (line: string) => console.log(`voice: ${line}`);

  if (args.acp) {
    await runVoiceAdapter({ home, name, ...(canvas ? { canvas } : {}) });
    return;
  }

  const hub = await connect({});
  const target = await hub.canvas(canvas);
  const who = await claimVoiceIdentity({
    home,
    client: hub.ctx.client,
    name,
    canvasId: target.id,
    onLine: say,
  });
  const server = await startVoiceServer({
    home,
    port: args.port ?? DEFAULT_VOICE_PORT,
    identity: { session: who.session, harness: who.harness },
    canvas: target.id,
    ...(args.model ? { model: args.model } : {}),
    onLine: say,
  });
  console.log(`\n  ${server.state.name} is listening on the canvas — talk at ${server.state.url}\n`);

  // Standing is not being summonable: the microphone speaks either way, and an
  // actor the rc has no row for is one nobody can invite. Said once, at start,
  // with the command that fixes it.
  const roster = await readRcAgents(home).catch(() => []);
  if (!roster.some((row) => row.canvasId === target.id && row.actorId === who.actor.id)) {
    console.log(
      `  not enrolled as a harness yet — the microphone speaks as ${who.actor.name} either way, but nothing can summon it.\n` +
        `  to invite it:  isocan rc add ${who.actor.name} --harness ${VOICE_HARNESS}\n`,
    );
  }

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.close();
  console.log("voice harness stopped");
}
