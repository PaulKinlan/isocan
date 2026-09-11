import { useEffect, useRef } from "react";
import { mountVoiceCheck } from "../lib/voice-check.ts";
import "./VoiceCheckPage.css";

/** This page intentionally has no provider/API client, identity or canvas dependency. */
export function VoiceCheckPage() {
  const root = useRef<HTMLElement>(null);
  useEffect(() => mountVoiceCheck(root.current!), []);
  return (
    <main className="voice-check" ref={root}>
      <a href="/">← Back to isocan</a>
      <header>
        <p className="voice-check-kicker">LOCAL AUDIO · NO AI SERVICE</p>
        <h1>Check your microphone</h1>
        <p>See your input level, record a short sample, then play it back.</p>
        <p>Audio stays in this tab. No API key, provider connection or upload.</p>
      </header>
      <section aria-label="Microphone">
        <p role="status" data-status>Ready. Nothing is recording.</p>
        <div className="voice-check-controls">
          <span data-native-control />
          <button className="btn" type="button" data-fallback>Use microphone</button>
          <button className="btn" type="button" data-stop disabled>Stop microphone</button>
        </div>
        <p className="voice-check-detail" data-capture-path />
        <button className="voice-check-link" type="button" data-switch-path hidden>Use the standard microphone button instead</button>
        <label htmlFor="voice-check-level">Input level <span data-level>0%</span></label>
        <meter id="voice-check-level" min="0" max="1" value="0" aria-label="Microphone input level" />
        <p className="voice-check-detail">Speak normally. This is a relative level, not a calibrated volume reading.</p>
      </section>
      <section aria-label="Local sample">
        <h2>Hear a sample</h2>
        <p>Record up to 10 seconds. Playback starts only when you press Play.</p>
        <div className="voice-check-controls">
          <button className="btn" type="button" data-record disabled>Record sample</button>
          <button className="btn" type="button" data-finish disabled>Finish recording</button>
          <button className="btn" type="button" data-reset>Reset</button>
        </div>
        <div data-clip hidden>
          <p>Your local sample</p>
          <audio controls aria-label="Play your local recording" />
        </div>
      </section>
      <footer>
        <p>This checks capture and local playback, not speech recognition or voice control.</p>
        <p>Reset, leaving this page or hiding the tab stops capture and discards the sample.</p>
      </footer>
    </main>
  );
}
