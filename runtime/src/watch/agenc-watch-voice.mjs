import { spawn } from "node:child_process";

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const CHUNK_INTERVAL_MS = 100;
const DEFAULT_STATUS_MAX_CHARS = 180;

function uint8ToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBuffer(base64) {
  return Buffer.from(base64, "base64");
}

function tryKill(proc) {
  if (!proc) return;
  try {
    if (!proc.killed) proc.kill("SIGTERM");
  } catch {
    // already dead
  }
}

function sanitizeVoiceText(value, fallback = null) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : fallback;
}

function compactVoiceText(value, maxChars = DEFAULT_STATUS_MAX_CHARS) {
  const text = sanitizeVoiceText(value, null);
  if (!text) {
    return null;
  }
  if (!Number.isFinite(Number(maxChars)) || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(1, Number(maxChars) - 1)).trimEnd()}…`;
}

export function createWatchVoiceController(dependencies = {}) {
  const {
    send = () => {},
    authPayload = (payload = {}) => payload,
    pushEvent = () => {},
    setTransientStatus = () => {},
    watchState = null,
    nowMs = Date.now,
  } = dependencies;

  let recorder = null;
  let player = null;
  let chunkTimer = null;
  let audioBuffer = Buffer.alloc(0);
  let active = false;

  function buildSnapshot(overrides = {}) {
    return {
      active: false,
      connectionState: "disconnected",
      companionState: "stopped",
      voice: null,
      mode: null,
      sessionId: null,
      managedSessionId: null,
      currentTask: null,
      delegationStatus: null,
      lastUserTranscript: null,
      lastAssistantTranscript: null,
      lastError: null,
      updatedAtMs: nowMs(),
      ...overrides,
    };
  }

  function readSnapshot() {
    if (!watchState || typeof watchState !== "object") {
      return null;
    }
    return watchState.voiceCompanion ?? null;
  }

  function writeSnapshot(snapshot) {
    if (watchState && typeof watchState === "object") {
      watchState.voiceCompanion = snapshot;
    }
    return snapshot;
  }

  function updateSnapshot(patch = {}) {
    const snapshot = buildSnapshot({
      ...(readSnapshot() ?? {}),
      ...patch,
      updatedAtMs: nowMs(),
    });
    return writeSnapshot(snapshot);
  }

  function deriveCompanionState(connectionState, fallback = "listening") {
    const normalized = sanitizeVoiceText(connectionState, "unknown");
    if (normalized === "connecting" || normalized === "reconnecting") {
      return "connecting";
    }
    if (normalized === "connected") {
      return fallback;
    }
    if (normalized === "disconnected") {
      return "stopped";
    }
    if (normalized === "error") {
      return "error";
    }
    return fallback;
  }

  function mergeStatePayload(payload = {}, fallbackCompanionState = "listening") {
    const normalizedConnectionState = sanitizeVoiceText(
      payload?.connectionState,
      readSnapshot()?.connectionState ?? "connected",
    );
    const companionState = sanitizeVoiceText(
      payload?.companionState,
      deriveCompanionState(normalizedConnectionState, fallbackCompanionState),
    );
    const activeValue =
      typeof payload?.active === "boolean"
        ? payload.active
        : normalizedConnectionState !== "disconnected";
    return updateSnapshot({
      active: activeValue,
      connectionState: normalizedConnectionState,
      companionState,
      voice: sanitizeVoiceText(payload?.voice, readSnapshot()?.voice ?? null),
      mode: sanitizeVoiceText(payload?.mode, readSnapshot()?.mode ?? null),
      sessionId: sanitizeVoiceText(payload?.sessionId, readSnapshot()?.sessionId ?? null),
      managedSessionId: sanitizeVoiceText(
        payload?.managedSessionId,
        readSnapshot()?.managedSessionId ?? null,
      ),
      lastError: companionState === "error"
        ? compactVoiceText(payload?.message ?? payload?.error, DEFAULT_STATUS_MAX_CHARS)
        : readSnapshot()?.lastError ?? null,
    });
  }

  function formatStatusReport(snapshot = readSnapshot()) {
    const state = snapshot ?? buildSnapshot();
    const lines = [
      "Voice Companion",
      `- Active: ${state.active ? "yes" : "no"}`,
      `- State: ${sanitizeVoiceText(state.companionState, "stopped")}`,
      `- Connection: ${sanitizeVoiceText(state.connectionState, "disconnected")}`,
      `- Voice: ${sanitizeVoiceText(state.voice, "default")}`,
      `- Mode: ${sanitizeVoiceText(state.mode, "vad")}`,
    ];
    if (sanitizeVoiceText(state.sessionId, null)) {
      lines.push(`- Session: ${state.sessionId}`);
    }
    if (sanitizeVoiceText(state.managedSessionId, null)) {
      lines.push(`- Shared session: ${state.managedSessionId}`);
    }
    if (sanitizeVoiceText(state.delegationStatus, null)) {
      lines.push(`- Delegation: ${state.delegationStatus}`);
    }
    if (sanitizeVoiceText(state.currentTask, null)) {
      lines.push(`- Current task: ${state.currentTask}`);
    }
    if (sanitizeVoiceText(state.lastUserTranscript, null)) {
      lines.push(`- Last heard: ${state.lastUserTranscript}`);
    }
    if (sanitizeVoiceText(state.lastAssistantTranscript, null)) {
      lines.push(`- Last reply: ${state.lastAssistantTranscript}`);
    }
    if (sanitizeVoiceText(state.lastError, null)) {
      lines.push(`- Last error: ${state.lastError}`);
    }
    return lines.join("\n");
  }

  function startRecorder() {
    try {
      recorder = spawn("arecord", [
        "-D", "default",
        "-f", "S16_LE",
        "-r", String(SAMPLE_RATE),
        "-c", String(CHANNELS),
        "-t", "raw",
        "-q",
        "-",
      ], { stdio: ["ignore", "pipe", "ignore"] });

      recorder.stdout.on("data", (chunk) => {
        audioBuffer = Buffer.concat([audioBuffer, chunk]);
      });

      recorder.on("error", (err) => {
        pushEvent("error", "Voice Error",
          `Microphone failed: ${err.message}\nMake sure arecord is available and a mic is connected.`, "red");
        cleanupLocal();
      });

      recorder.on("exit", () => {
        recorder = null;
      });

      // Send audio chunks at fixed intervals
      chunkTimer = setInterval(() => {
        if (audioBuffer.length === 0) return;
        const chunk = audioBuffer;
        audioBuffer = Buffer.alloc(0);
        send("voice.audio", authPayload({ audio: uint8ToBase64(chunk) }));
      }, CHUNK_INTERVAL_MS);
    } catch (err) {
      pushEvent("error", "Voice Error", `Could not start mic: ${err.message}`, "red");
    }
  }

  function stopRecorder() {
    if (chunkTimer) {
      clearInterval(chunkTimer);
      chunkTimer = null;
    }
    tryKill(recorder);
    recorder = null;
    audioBuffer = Buffer.alloc(0);
  }

  // Playback: spawn one aplay process and keep its stdin open for streaming.
  // Kill it to interrupt (barge-in).
  function ensurePlayer() {
    if (player && !player.killed) return player;
    try {
      player = spawn("aplay", [
        "-f", "S16_LE",
        "-r", String(SAMPLE_RATE),
        "-c", String(CHANNELS),
        "-t", "raw",
        "-q",
        "-",
      ], { stdio: ["pipe", "ignore", "ignore"] });

      player.stdin.on("error", () => {
        // pipe broken — player died, will be respawned on next audio
      });
      player.on("error", () => { player = null; });
      player.on("exit", () => { player = null; });
      return player;
    } catch {
      return null;
    }
  }

  function playAudio(base64) {
    const p = ensurePlayer();
    if (p && p.stdin.writable) {
      p.stdin.write(base64ToBuffer(base64));
    }
  }

  function interruptPlayback() {
    tryKill(player);
    player = null;
  }

  function cleanupLocal() {
    active = false;
    stopRecorder();
    interruptPlayback();
  }

  function startVoice() {
    if (active) {
      pushEvent("voice", "Voice", "Already active. /voice stop to end.", "amber");
      return;
    }
    active = true;
    updateSnapshot({
      active: true,
      connectionState: "connecting",
      companionState: "connecting",
      currentTask: null,
      delegationStatus: null,
      lastError: null,
    });
    setTransientStatus("voice: connecting...");
    send("voice.start", authPayload({}));
  }

  function stopVoice() {
    cleanupLocal();
    updateSnapshot({
      active: false,
      connectionState: "disconnected",
      companionState: "stopped",
      currentTask: null,
      delegationStatus: null,
    });
    try {
      send("voice.stop", authPayload({}));
    } catch {
      // socket might already be closed
    }
    setTransientStatus("voice: stopped");
  }

  function handleVoiceMessage(type, payload) {
    switch (type) {
      case "voice.started":
        active = true;
        mergeStatePayload(payload, "listening");
        setTransientStatus("voice: listening (speak now)");
        pushEvent("voice", "Voice", "Listening. Speak now.", "green");
        startRecorder();
        return true;

      case "voice.stopped":
        cleanupLocal();
        mergeStatePayload(payload, "stopped");
        setTransientStatus("voice: disconnected");
        return true;

      case "voice.audio":
        if (payload?.audio) {
          playAudio(payload.audio);
          updateSnapshot({ companionState: "speaking" });
        }
        return true;

      case "voice.transcript":
        if (payload?.done && payload?.text) {
          updateSnapshot({
            companionState: "listening",
            lastAssistantTranscript: compactVoiceText(payload.text),
          });
          pushEvent("voice", "Agent", payload.text, "cyan");
        } else if (payload?.delta) {
          updateSnapshot({ companionState: "speaking" });
          setTransientStatus(`agent: ${payload.delta.slice(-60)}`);
        }
        return true;

      case "voice.user_transcript":
        if (payload?.text) {
          updateSnapshot({
            companionState: "processing",
            lastUserTranscript: compactVoiceText(payload.text),
            lastError: null,
          });
          pushEvent("voice", "You (voice)", payload.text, "green");
        }
        return true;

      case "voice.speech_started":
        // User started talking — kill playback so agent shuts up
        interruptPlayback();
        updateSnapshot({
          companionState: "listening",
          delegationStatus: null,
          currentTask: null,
        });
        setTransientStatus("voice: listening...");
        return true;

      case "voice.speech_stopped":
        updateSnapshot({ companionState: "processing" });
        setTransientStatus("voice: processing...");
        return true;

      case "voice.response_done":
        updateSnapshot({ companionState: "listening" });
        setTransientStatus("voice: listening");
        return true;

      case "voice.delegation":
        if (payload?.status === "started") {
          updateSnapshot({
            companionState: "delegating",
            currentTask: compactVoiceText(payload.task, 240),
            delegationStatus: "started",
            lastError: null,
          });
          setTransientStatus(`voice: working on "${(payload.task ?? "").slice(0, 40)}..."`);
          pushEvent("voice", "Delegation", `Task: ${payload.task}`, "purple");
        } else if (payload?.status === "completed") {
          updateSnapshot({
            companionState: "listening",
            currentTask: null,
            delegationStatus: "completed",
            lastError: null,
          });
          pushEvent("voice", "Delegation Done", (payload.content ?? "").slice(0, 500), "teal");
        } else if (payload?.status === "blocked") {
          const errorMessage = compactVoiceText(
            payload.error ?? payload.reason ?? payload.content ?? "voice delegation blocked",
            240,
          );
          updateSnapshot({
            companionState: "blocked",
            delegationStatus: "blocked",
            currentTask: compactVoiceText(payload.task, 240),
            lastError: errorMessage,
          });
          pushEvent("voice", "Delegation Blocked", errorMessage, "amber");
        } else if (payload?.status === "error") {
          const errorMessage = compactVoiceText(payload.error ?? "unknown", 240);
          updateSnapshot({
            companionState: "error",
            delegationStatus: "error",
            currentTask: compactVoiceText(payload.task, 240),
            lastError: errorMessage,
          });
          pushEvent("voice", "Delegation Error", errorMessage, "red");
        }
        return true;

      case "voice.state":
        mergeStatePayload(payload, "listening");
        if (payload?.connectionState === "disconnected" && active) {
          cleanupLocal();
        }
        setTransientStatus(
          `voice: ${payload?.companionState ?? payload?.connectionState ?? "unknown"}`,
        );
        return true;

      case "voice.error":
        cleanupLocal();
        updateSnapshot({
          active: false,
          connectionState: "disconnected",
          companionState: "error",
          delegationStatus: "error",
          lastError: compactVoiceText(payload?.message ?? "unknown voice error", 240),
        });
        pushEvent("error", "Voice Error", payload?.message ?? "unknown voice error", "red");
        return true;

      default:
        return false;
    }
  }

  return {
    startVoice,
    stopVoice,
    handleVoiceMessage,
    formatStatusReport,
    getSnapshot() {
      return readSnapshot();
    },
    get active() { return active; },
  };
}
