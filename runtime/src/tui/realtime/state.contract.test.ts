import { describe, expect, test } from "vitest";

import {
  effectiveRealtimeMicrophoneMuted,
  formatRealtimeItemSummary,
  initialRealtimeTuiState,
  realtimeLevelBar,
  reduceRealtimeTuiState,
} from "./state.js";

describe("AgenC TUI realtime state", () => {
  test("tracks voice lifecycle phases and close/error banners", () => {
    const starting = reduceRealtimeTuiState(initialRealtimeTuiState(), {
      type: "start_requested",
      transport: "webrtc",
    });
    expect(starting).toMatchObject({
      phase: "starting",
      transport: "webrtc",
      requestedClose: false,
      errorBanner: null,
      closedBanner: null,
    });

    const active = reduceRealtimeTuiState(starting, {
      type: "started",
      realtimeSessionId: "rt_1",
    });
    expect(active).toMatchObject({
      phase: "starting",
      realtimeSessionId: "rt_1",
    });

    const connected = reduceRealtimeTuiState(active, { type: "connected" });
    expect(connected).toMatchObject({
      phase: "active",
      realtimeSessionId: "rt_1",
    });

    const stopping = reduceRealtimeTuiState(connected, {
      type: "stop_requested",
    });
    expect(stopping).toMatchObject({
      phase: "stopping",
      requestedClose: true,
    });

    const closed = reduceRealtimeTuiState(stopping, {
      type: "closed",
      reason: "requested",
    });
    expect(closed).toMatchObject({
      phase: "inactive",
      requestedClose: false,
      transport: null,
      realtimeSessionId: null,
      closedBanner: "Realtime closed: requested",
    });

    const failed = reduceRealtimeTuiState(active, {
      type: "error",
      message: "microphone denied",
    });
    expect(failed).toMatchObject({
      phase: "inactive",
      errorBanner: "microphone denied",
    });

    const closedAfterError = reduceRealtimeTuiState(failed, {
      type: "closed",
      reason: "remote closed",
    });
    expect(closedAfterError).toMatchObject({
      errorBanner: null,
      closedBanner: "Realtime closed: remote closed",
    });
  });

  test("tracks mute, push-to-talk, local meter, transcript, and items", () => {
    let state = initialRealtimeTuiState();
    state = reduceRealtimeTuiState(state, { type: "muted_changed", muted: true });
    expect(effectiveRealtimeMicrophoneMuted(state)).toBe(true);

    state = reduceRealtimeTuiState(state, { type: "muted_changed", muted: false });
    state = reduceRealtimeTuiState(state, {
      type: "push_to_talk_changed",
      enabled: true,
    });
    expect(effectiveRealtimeMicrophoneMuted(state)).toBe(true);

    state = reduceRealtimeTuiState(state, {
      type: "push_to_talk_held_changed",
      held: true,
    });
    expect(effectiveRealtimeMicrophoneMuted(state)).toBe(false);

    state = reduceRealtimeTuiState(state, {
      type: "local_audio_level",
      peak: 32768,
    });
    expect(state.localAudioLevel).toBe(32768);
    expect(realtimeLevelBar(state.localAudioLevel, 4)).toBe("##--");

    state = reduceRealtimeTuiState(state, {
      type: "transcript_delta",
      role: "assistant",
      delta: "hel",
    });
    state = reduceRealtimeTuiState(state, {
      type: "transcript_delta",
      role: "assistant",
      delta: "lo",
    });
    expect(state.lastTranscript).toEqual({ role: "assistant", text: "hello" });

    state = reduceRealtimeTuiState(state, {
      type: "item_added",
      item: { type: "message", id: "item_1" },
    });
    expect(state.lastItemSummary).toBe("message item_1");
    expect(formatRealtimeItemSummary(["a", "b"])).toBe("array(2)");
  });
});
