import test from "node:test";
import assert from "node:assert/strict";

import { createWatchVoiceController } from "../../src/watch/agenc-watch-voice.mjs";

test("createWatchVoiceController maintains a visible companion snapshot", () => {
  const calls = [];
  const watchState = { voiceCompanion: null };
  const controller = createWatchVoiceController({
    watchState,
    authPayload(payload = {}) {
      return { auth: true, ...payload };
    },
    send(type, payload) {
      calls.push({ type, payload });
    },
    pushEvent(kind, title, body, tone) {
      calls.push({ event: { kind, title, body, tone } });
    },
    setTransientStatus(status) {
      calls.push({ status });
    },
    nowMs() {
      return 1_730_000_000_000;
    },
  });

  controller.startVoice();

  assert.equal(controller.active, true);
  assert.deepEqual(watchState.voiceCompanion, {
    active: true,
    connectionState: "connecting",
    companionState: "connecting",
    voice: null,
    mode: null,
    sessionId: null,
    managedSessionId: null,
    currentTask: null,
    delegationStatus: null,
    lastUserTranscript: null,
    lastAssistantTranscript: null,
    lastError: null,
    updatedAtMs: 1_730_000_000_000,
  });
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "voice.start" &&
        entry.payload?.auth === true,
    ),
  );

  controller.handleVoiceMessage("voice.state", {
    active: true,
    connectionState: "connected",
    companionState: "listening",
    voice: "Ara",
    mode: "vad",
    sessionId: "voice:client-1",
    managedSessionId: "session-managed-1",
  });
  controller.handleVoiceMessage("voice.user_transcript", {
    text: "Open the release dashboard",
  });
  controller.handleVoiceMessage("voice.delegation", {
    status: "started",
    task: "Open the release dashboard",
  });
  controller.handleVoiceMessage("voice.transcript", {
    text: "I opened the release dashboard.",
    done: true,
  });
  controller.handleVoiceMessage("voice.delegation", {
    status: "completed",
    content: "Opened the release dashboard",
  });

  assert.equal(watchState.voiceCompanion.active, true);
  assert.equal(watchState.voiceCompanion.connectionState, "connected");
  assert.equal(watchState.voiceCompanion.companionState, "listening");
  assert.equal(watchState.voiceCompanion.voice, "Ara");
  assert.equal(watchState.voiceCompanion.mode, "vad");
  assert.equal(watchState.voiceCompanion.sessionId, "voice:client-1");
  assert.equal(watchState.voiceCompanion.managedSessionId, "session-managed-1");
  assert.equal(watchState.voiceCompanion.currentTask, null);
  assert.equal(watchState.voiceCompanion.delegationStatus, "completed");
  assert.equal(
    watchState.voiceCompanion.lastUserTranscript,
    "Open the release dashboard",
  );
  assert.equal(
    watchState.voiceCompanion.lastAssistantTranscript,
    "I opened the release dashboard.",
  );

  const report = controller.formatStatusReport();
  assert.match(report, /Voice Companion/);
  assert.match(report, /State: listening/);
  assert.match(report, /Voice: Ara/);
  assert.match(report, /Delegation: completed/);
  assert.match(report, /Last heard: Open the release dashboard/);
});

test("createWatchVoiceController captures disconnect and error state without daemon help", () => {
  const watchState = { voiceCompanion: null };
  const controller = createWatchVoiceController({
    watchState,
    authPayload(payload = {}) {
      return payload;
    },
    send() {},
    pushEvent() {},
    setTransientStatus() {},
    nowMs() {
      return 1_730_000_100_000;
    },
  });

  controller.startVoice();
  controller.handleVoiceMessage("voice.state", {
    active: true,
    connectionState: "connected",
    companionState: "delegating",
    voice: "Ara",
    mode: "push-to-talk",
    sessionId: "voice:client-2",
    managedSessionId: "session-managed-2",
  });
  controller.handleVoiceMessage("voice.error", {
    message: "microphone permissions unavailable",
  });

  assert.equal(controller.active, false);
  assert.equal(watchState.voiceCompanion.active, false);
  assert.equal(watchState.voiceCompanion.connectionState, "disconnected");
  assert.equal(watchState.voiceCompanion.companionState, "error");
  assert.equal(
    watchState.voiceCompanion.lastError,
    "microphone permissions unavailable",
  );
});
