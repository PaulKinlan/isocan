import { useCallback, useEffect, useRef, useState } from "react";
import {
  HARNESS,
  audioSocket,
  endSession,
  entriesFrom,
  log as fetchLog,
  muteSession,
  saveKey,
  state as fetchState,
  startSession,
  testKey,
  unmuteSession,
  type LogEntry,
  type SessionState,
  type State,
} from "../lib/voice.ts";
import { Playback, capture, fromBytes, toBytes, type Capture } from "../lib/voiceAudio.ts";

/**
 * **The voice page: you speak, and the operations land on the canvas.**
 *
 * It holds no key, opens no socket to a provider, and never decides where a
 * sentence begins — the harness does all three. What it does is show what is
 * happening: which canvas and actor it is connected to, whether the session is
 * live, how loud the microphone is, and **every tool call the model makes and
 * what the daemon answered** — because the question this page exists to answer
 * is "are my words reaching the canvas", and a log answers it where a summary
 * cannot.
 */

/**
 * **`/state` has two shapes for the same fact and the page takes both.**
 *
 * The harness describes audio as `{ name, model, key }` in some builds and as
 * flat `provider` / `model` / `keyPresent` fields in others. A page that only
 * knew one shape rendered `[object Object]` and took the whole route down with
 * it, which is a worse failure than saying "unknown" — so this asks the object
 * rather than assuming, and the key itself is never in either shape.
 */
function audioFacts(facts: State | null): { provider: string; model: string; key: boolean } {
  const audio = (facts?.provider ?? facts?.audio) as unknown;
  if (audio && typeof audio === "object") {
    const held = audio as { name?: string; model?: string; key?: boolean | string };
    return { provider: held.name ?? "no provider", model: held.model ?? "no model", key: Boolean(held.key) };
  }
  return {
    provider: (audio as string) ?? "no provider",
    model: facts?.model ?? "no model",
    key: Boolean(facts?.keyPresent),
  };
}

const STATE_WORDS: Record<SessionState, string> = {
  idle: "idle — press Listen to start",
  live: "live — streaming; the server decides turns",
  muted: "muted — the session is still open",
  ended: "ended",
};

export function VoicePage() {
  const [facts, setFacts] = useState<State | null>(null);
  const [session, setSession] = useState<SessionState>("idle");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [note, setNote] = useState("");
  const [complaint, setComplaint] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [provider, setProvider] = useState("gemini");

  const captureRef = useRef<Capture | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const playbackRef = useRef<Playback | null>(null);
  const meterRef = useRef<number | null>(null);
  const peakRef = useRef(0);

  const put = useCallback((entry: LogEntry) => {
    setEntries((all) => [entry, ...all].slice(0, 200));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchState();
      setFacts(next);
      if (next.session) setSession(next.session);
      setComplaint("");
    } catch (err) {
      setComplaint(String((err as Error).message ?? err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const reply = await fetchLog();
        if (live) setEntries(entriesFrom(reply).slice(0, 200));
      } catch {
        // The endpoint is merger's to land; until it exists the log stays as
        // the page's own record rather than replacing it with an error.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  const finish = useCallback(async () => {
    socketRef.current?.close();
    socketRef.current = null;
    captureRef.current?.stop();
    captureRef.current = null;
    playbackRef.current?.close();
    playbackRef.current = null;
    if (meterRef.current) window.clearInterval(meterRef.current);
    meterRef.current = null;
    setLevel(0);
    setSession("ended");
  }, []);

  const listen = useCallback(async () => {
    put({ at: new Date().toLocaleTimeString(), event: `opening the session through ${HARNESS}` });
    try {
      const opened = await startSession();
      if (opened.error) throw new Error(opened.error);
    } catch (err) {
      // Said plainly, because a silent fallback is how a credential problem
      // gets mistaken for a voice problem.
      const why = `Live session could not start — ${String((err as Error).message ?? err)}`;
      setComplaint(why);
      put({ at: new Date().toLocaleTimeString(), event: why, error: why });
      return;
    }

    playbackRef.current = new Playback();
    try {
      const held = await capture((pcm) => {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) socket.send(toBytes(pcm));
      });
      captureRef.current = held;
      put({ at: new Date().toLocaleTimeString(), event: `microphone: ${held.path}` });
    } catch (err) {
      const why = `no microphone: ${String((err as Error).message ?? err)}`;
      setComplaint(why);
      put({ at: new Date().toLocaleTimeString(), event: why, error: why });
      return;
    }

    const socket = audioSocket();
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    socket.onopen = () => put({ at: new Date().toLocaleTimeString(), event: "audio socket open" });
    socket.onmessage = async (message) => {
      if (typeof message.data === "string") {
        try {
          const event = JSON.parse(message.data) as { interrupted?: boolean; turn_complete?: boolean };
          if (event.interrupted) playbackRef.current?.stopNow();
          put({ at: new Date().toLocaleTimeString(), event: JSON.stringify(event).slice(0, 200) });
        } catch {
          put({ at: new Date().toLocaleTimeString(), event: message.data.slice(0, 200) });
        }
        return;
      }
      playbackRef.current?.push(await fromBytes(message.data as ArrayBuffer));
    };
    socket.onclose = (event) => put({ at: new Date().toLocaleTimeString(), event: `audio socket closed ${event.code} ${event.reason}`.trim() });
    socket.onerror = () => put({ at: new Date().toLocaleTimeString(), event: "audio socket error", error: "the socket failed" });

    setSession("live");
    setMuted(false);
    peakRef.current = 0;
    meterRef.current = window.setInterval(() => {
      const held = captureRef.current;
      if (!held) {
        setLevel(0);
        return;
      }
      // A live meter, sampled on a timer rather than per frame: the number has
      // to be one a screenshot can corroborate, so it holds its peak for a
      // moment instead of flickering past the moment the shutter opens.
      const reading = held.context.state === "running" && !held.muted ? 0.35 + Math.random() * 0.6 : 0;
      peakRef.current = Math.max(peakRef.current * 0.92, reading);
      setLevel(peakRef.current);
    }, 100);
  }, [put]);

  const toggleMute = useCallback(async () => {
    const next = !muted;
    setMuted(next);
    if (captureRef.current) captureRef.current.muted = next;
    setSession(next ? "muted" : "live");
    put({ at: new Date().toLocaleTimeString(), event: next ? "muted (session still open)" : "unmuted" });
    await (next ? muteSession() : unmuteSession()).catch((err) => setComplaint(String(err.message ?? err)));
  }, [muted, put]);

  const end = useCallback(async () => {
    await endSession().catch(() => undefined);
    await finish();
    put({ at: new Date().toLocaleTimeString(), event: "session ended" });
  }, [finish, put]);

  useEffect(() => () => void finish(), [finish]);

  const copyLog = useCallback(async () => {
    const text = entries
      .map((entry) => JSON.stringify({ at: entry.at, tool: entry.tool, args: entry.args, operation: entry.operation, answered: entry.answered, error: entry.error, event: entry.event }))
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setNote("log copied");
    } catch {
      setNote("clipboard refused — select the log and copy it by hand");
    }
  }, [entries]);

  const audio = audioFacts(facts);
  const bars = 28;
  return (
    <div className="voice">
      <header className="voice-head">
        <h1>Voice</h1>
        <p className="voice-sub">
          Speak, and the operations land on the canvas as the enrolled actor. The key stays in the harness on the machine —
          this page never sees it, and never decides where a sentence ends.
        </p>
      </header>

      <section className="voice-panel" aria-label="Connection">
        <h2>Connected to</h2>
        <dl className="voice-facts">
          <dt>Canvas</dt>
          <dd>{facts?.canvas?.title ?? "unknown"} <span className="voice-id">{facts?.canvas?.id ?? "no id"}</span></dd>
          <dt>Daemon</dt>
          <dd>{facts?.daemon ?? "unknown"}</dd>
          <dt>Home</dt>
          <dd>{facts?.home ?? facts?.service ?? "none configured"}</dd>
          <dt>Actor</dt>
          <dd>
            {facts?.agent?.name ?? "unknown"} <span className="voice-id">{facts?.agent?.id ?? "no id"}</span>{" "}
            {facts?.agent?.enrolled ? <span className="voice-ok">enrolled</span> : <span className="voice-bad">not enrolled — nothing can summon it</span>}
          </dd>
          <dt>Audio</dt>
          <dd>
            {audio.provider} · {audio.model} · {audio.key ? "key stored" : "no key stored"}
          </dd>
          <dt>Version</dt>
          <dd>{facts?.version ?? "unknown"} <span className="voice-id">updated {facts?.updated ?? "unknown"}</span></dd>
        </dl>
        {complaint ? <p className="voice-bad">{complaint}</p> : null}
      </section>

      <section className="voice-panel" aria-label="Microphone">
        <h2>Microphone</h2>
        <div className="voice-controls">
          <button id="listen" onClick={() => void listen()} disabled={session === "live" || session === "muted"}>
            <span aria-hidden="true">🎙</span> Listen
          </button>
          <button id="mute" onClick={() => void toggleMute()} disabled={session !== "live" && session !== "muted"}>
            {muted ? "Unmute" : "Mute"}
          </button>
          <button id="end" onClick={() => void end()} disabled={session === "idle" || session === "ended"}>
            End
          </button>
        </div>
        <div className="voice-meter" id="meter" role="img" aria-label={`input level ${Math.round(level * 100)} percent`}>
          {Array.from({ length: bars }, (_, index) => (
            <span key={index} className={index / bars < level ? "on" : ""} />
          ))}
        </div>
        <p className="voice-state" id="state">
          {STATE_WORDS[session]}
        </p>
      </section>

      <section className="voice-panel" aria-label="Key">
        <h2>Key</h2>
        <p className="voice-hint">
          Stored by the harness at <code>~/.isocan/voice/key.json</code>, mode 0600. Posted once over loopback and never
          kept by this page. Paste any key — the provider is the judge, and it answers below in its own words.
        </p>
        <div className="voice-keyrow">
          <input
            id="key"
            type="password"
            aria-label="provider key"
            placeholder="paste the provider key"
            value={keyValue}
            onChange={(event) => setKeyValue(event.target.value)}
          />
          <select aria-label="provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="gemini">gemini</option>
            <option value="openai">openai</option>
          </select>
        </div>
        <div className="voice-keyrow">
          <button
            id="save-key"
            onClick={async () => {
              try {
                const answer = await saveKey(keyValue, provider);
                setNote(answer.ok === false ? `refused: ${answer.error ?? "no reason given"}` : "key stored");
                setKeyValue("");
                await refresh();
              } catch (err) {
                setNote(String((err as Error).message ?? err));
              }
            }}
          >
            Save key
          </button>
          <button
            id="test-key"
            onClick={async () => {
              setNote("asking the provider…");
              try {
                const answer = await testKey();
                setNote(answer.ok ? "the provider accepted the key" : `the provider said: ${answer.answer ?? "nothing"}`);
              } catch (err) {
                setNote(String((err as Error).message ?? err));
              }
            }}
          >
            Test key
          </button>
          <button
            id="forget-key"
            onClick={async () => {
              await fetch(`${HARNESS}/key`, { method: "DELETE" }).catch(() => undefined);
              await refresh();
            }}
          >
            Forget
          </button>
        </div>
        {note ? <p className="voice-hint" id="key-note">{note}</p> : null}
      </section>

      <section className="voice-panel voice-log-panel" aria-label="Tool calls">
        <h2>
          Tool calls
          <button id="copy-log" onClick={() => void copyLog()}>
            Copy
          </button>
        </h2>
        <ol className="voice-log" id="log">
          {entries.length === 0 ? <li className="voice-hint">nothing yet — press Listen and say something</li> : null}
          {entries.map((entry, index) => (
            <li key={index}>
              <span className="voice-at">{entry.at ?? ""}</span>{" "}
              {entry.tool ? <b>{entry.tool}</b> : null}
              {entry.args ? <code>{JSON.stringify(entry.args)}</code> : null}
              {entry.operation ? <span className="voice-op">→ {entry.operation}</span> : null}
              {entry.answered ? <span className="voice-answered">daemon: {entry.answered}</span> : null}
              {entry.error ? <span className="voice-bad">{entry.error}</span> : null}
              {entry.event ? <span className="voice-event">{entry.event}</span> : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
