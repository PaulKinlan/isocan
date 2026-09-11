/** Local-only capture check. No API client, provider, credential or network dependency. */
interface MicrophoneControl extends HTMLElement {
  track: MediaStreamTrack | null;
  error: DOMException | null;
  setConstraints(constraints: MediaTrackConstraintSet): void;
}

/** Display -60..0 dBFS as a bounded level, not a microphone calibration. */
export function inputLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  return rms > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60)) : 0;
}

export function mountVoiceCheck(root: HTMLElement): () => void {
  const find = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
  const status = find<HTMLElement>("[data-status]");
  const path = find<HTMLElement>("[data-capture-path]");
  const slot = find<HTMLElement>("[data-native-control]");
  const fallback = find<HTMLButtonElement>("[data-fallback]");
  const switchPath = find<HTMLButtonElement>("[data-switch-path]");
  const stop = find<HTMLButtonElement>("[data-stop]");
  const record = find<HTMLButtonElement>("[data-record]");
  const finish = find<HTMLButtonElement>("[data-finish]");
  const reset = find<HTMLButtonElement>("[data-reset]");
  const meter = find<HTMLMeterElement>("meter");
  const level = find<HTMLElement>("[data-level]");
  const clip = find<HTMLElement>("[data-clip]");
  const player = find<HTMLAudioElement>("audio");
  const listeners = new AbortController();
  let alive = true;
  let generation = 0;
  let pending = false;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let frame = 0;
  let recorder: MediaRecorder | null = null;
  let recordingGeneration = 0;
  let recordingTimer: ReturnType<typeof setTimeout> | undefined;
  let clipUrl: string | null = null;
  let native: MicrophoneControl | null = null;
  let nativeGeneration = 0;
  const supported = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== "undefined";
  // Modern usermedia always requests camera AND microphone. setConstraints
  // only changes hardware preferences; it cannot narrow that permission.
  // Do not restore that "fallback" or enable its legacy mode for a mic check.
  const nativeAvailable = "HTMLMicrophoneElement" in window;
  const say = (text: string) => { if (alive) status.textContent = text; };
  const stopTracks = (media: MediaStream) => media.getTracks().forEach((track) => track.stop());
  const refresh = () => {
    stop.disabled = !stream && !pending;
    fallback.disabled = !supported || !!stream || pending;
    record.disabled = !stream || !!recorder || typeof MediaRecorder === "undefined";
    finish.disabled = !recorder;
    native?.setAttribute("aria-disabled", String(pending));
  };
  const clearClip = () => {
    player.pause();
    player.removeAttribute("src");
    player.load();
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    clipUrl = null;
    clip.hidden = true;
  };
  const finishRecording = () => {
    clearTimeout(recordingTimer);
    recordingTimer = undefined;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  };
  const stopCapture = () => {
    ++generation; // A permission grant arriving after Stop must be discarded.
    pending = false;
    finishRecording();
    if (stream) stopTracks(stream);
    stream = null;
    cancelAnimationFrame(frame);
    source?.disconnect();
    source = null;
    if (context) void context.close().catch(() => {});
    context = null;
    meter.value = 0;
    level.textContent = "0%";
    refresh();
  };
  const failed = (error: unknown) => {
    stopCapture();
    const name = error instanceof DOMException ? error.name : "";
    say(name === "NotAllowedError" ? "Microphone access was not granted. You can try again using the browser control."
      : name === "NotFoundError" ? "No microphone was found. Connect one and try again."
      : name === "NotReadableError" ? "The microphone could not be opened. Check whether another app is using it."
      : "Capture could not start. Check your browser and microphone, then try again.");
  };
  const acceptStream = async (media: MediaStream, attempt: number) => {
    if (!alive || attempt !== generation || !pending) { stopTracks(media); return; }
    if (media.getVideoTracks().length || media.getAudioTracks().length === 0) {
      stopTracks(media);
      failed(new Error("Expected audio only"));
      return;
    }
    stream = media;
    try {
      const audio = new AudioContext();
      context = audio;
      await audio.resume();
      if (!alive || attempt !== generation) { stopTracks(media); return; }
      source = audio.createMediaStreamSource(media);
      const analyser = audio.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser); // Deliberately no speaker connection: avoid feedback.
      const samples = new Float32Array(analyser.fftSize);
      const tick = () => {
        if (!alive || attempt !== generation) return;
        analyser.getFloatTimeDomainData(samples);
        meter.value = inputLevel(samples);
        level.textContent = `${Math.round(meter.value * 100)}%`;
        frame = requestAnimationFrame(tick);
      };
      pending = false;
      for (const track of media.getAudioTracks()) track.addEventListener("ended", () => {
        if (stream === media) { stopCapture(); say("Microphone ended. You can start again."); }
      }, { once: true });
      refresh();
      say(typeof MediaRecorder === "undefined"
        ? "Microphone on. This browser can show levels but cannot record a playback sample."
        : "Microphone on. Speak to check the meter, then record a short sample.");
      tick();
    } catch (error) {
      if (alive && attempt === generation) failed(error);
      else stopTracks(media);
    }
  };
  const begin = () => {
    pending = true;
    const attempt = ++generation;
    refresh();
    say("Waiting for microphone permission…");
    return attempt;
  };
  fallback.addEventListener("click", () => {
    const attempt = begin();
    void navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then((media) => acceptStream(media, attempt))
      .catch((error: unknown) => { if (alive && attempt === generation) failed(error); });
  }, { signal: listeners.signal });

  if (supported && nativeAvailable) {
    native = document.createElement("microphone") as MicrophoneControl;
    native.setConstraints({ echoCancellation: true, noiseSuppression: true });
    native.addEventListener("click", (event) => {
      if (pending) { event.preventDefault(); return; }
      // Preserve the element's native mute/unmute control while active.
      if (stream) return;
      nativeGeneration = begin();
    });
    // Retain the late-grant handler even when detached: it closes a stream
    // granted after unmount, rather than leaving hardware running unseen.
    const control = native;
    control.addEventListener("track", () => {
      if (control.track) void acceptStream(new MediaStream([control.track]), nativeGeneration);
    });
    control.addEventListener("cancel", () => {
      if (alive && nativeGeneration === generation) { stopCapture(); say("Permission request dismissed. Nothing is recording."); }
    });
    control.addEventListener("error", () => {
      if (alive && nativeGeneration === generation) failed(control.error);
    });
    slot.replaceChildren(control);
    fallback.hidden = true;
    switchPath.hidden = false;
    path.textContent = "Permission path: native <microphone>.";
  } else {
    fallback.hidden = false;
    switchPath.hidden = true;
    path.textContent = "Permission path: JavaScript getUserMedia (microphone only)."
      + ("HTMLUserMediaElement" in window ? " This browser has <usermedia>, but it would also request unwanted camera permission, so we do not use it." : "");
  }
  switchPath.addEventListener("click", () => {
    stopCapture();
    slot.hidden = true;
    fallback.hidden = false;
    switchPath.hidden = true;
    path.textContent = "Permission path: JavaScript getUserMedia fallback (selected).";
    say("Ready. Use the microphone button to request access.");
  }, { signal: listeners.signal });
  stop.addEventListener("click", () => { stopCapture(); say("Microphone stopped. Any finished sample stays local until reset or exit."); }, { signal: listeners.signal });
  record.addEventListener("click", () => {
    if (!stream || recorder) return;
    const attempt = ++recordingGeneration;
    const parts: Blob[] = [];
    let broken = false;
    try {
      const current = new MediaRecorder(stream);
      recorder = current;
      current.addEventListener("dataavailable", (event) => { if (event.data.size) parts.push(event.data); });
      current.addEventListener("error", () => { broken = true; finishRecording(); say("Recording failed. Try another sample."); });
      current.addEventListener("stop", () => {
        if (recorder === current) recorder = null;
        clearTimeout(recordingTimer);
        if (alive) refresh();
        if (!alive || attempt !== recordingGeneration) return;
        if (broken || !parts.length) { say("No playable sample was recorded. Try again."); return; }
        clearClip();
        const blob = new Blob(parts, { type: current.mimeType || parts[0]!.type });
        clipUrl = URL.createObjectURL(blob);
        player.src = clipUrl;
        clip.hidden = false;
        say("Sample ready. Press Play to hear it; it has not been uploaded.");
      }, { once: true });
      current.start();
      recordingTimer = setTimeout(finishRecording, 10_000);
      refresh();
      say("Recording locally, up to 10 seconds. Finish whenever you are ready.");
    } catch {
      recorder = null;
      refresh();
      say("Recording is not available in this browser. The level meter still works.");
    }
  }, { signal: listeners.signal });
  finish.addEventListener("click", finishRecording, { signal: listeners.signal });
  reset.addEventListener("click", () => {
    ++recordingGeneration;
    stopCapture();
    clearClip();
    say("Reset. The local sample has been discarded.");
  }, { signal: listeners.signal });
  player.addEventListener("error", () => say("This browser could not play the local sample. Try recording again."), { signal: listeners.signal });
  const leave = () => { ++recordingGeneration; stopCapture(); clearClip(); say("Stopped because this page is no longer visible."); };
  document.addEventListener("visibilitychange", () => { if (document.hidden) leave(); }, { signal: listeners.signal });
  window.addEventListener("pagehide", leave, { signal: listeners.signal });
  refresh();
  if (!supported) {
    fallback.disabled = true;
    say(window.isSecureContext ? "This browser does not support microphone capture and a level meter." : "Open this page over HTTPS or localhost to use a microphone.");
  } else say("Ready. Microphone access starts only when you use the control below.");
  return () => {
    alive = false;
    ++recordingGeneration;
    stopCapture();
    clearClip();
    listeners.abort();
    native?.remove();
  };
}
