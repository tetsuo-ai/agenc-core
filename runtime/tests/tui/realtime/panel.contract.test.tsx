import React from "react";
import { describe, expect, test } from "vitest";

import { renderToString } from "../../utils/staticRender.js";
import { stringWidth } from "../ink/stringWidth.js";
import { getRealtimeStatusRenderParts, RealtimePanel } from "./RealtimePanel.js";
import {
  initialRealtimeTuiState,
  reduceRealtimeTuiState,
} from "./state.js";

describe("RealtimePanel", () => {
  test("renders lifecycle controls, meter, transcript preview, and banners", async () => {
    let state = reduceRealtimeTuiState(initialRealtimeTuiState(), {
      type: "start_requested",
      transport: "webrtc",
    });
    state = reduceRealtimeTuiState(state, {
      type: "started",
      realtimeSessionId: "rt_1",
    });
    state = reduceRealtimeTuiState(state, { type: "connected" });
    state = reduceRealtimeTuiState(state, {
      type: "local_audio_level",
      peak: 65535,
    });
    state = reduceRealtimeTuiState(state, {
      type: "muted_changed",
      muted: true,
    });
    state = reduceRealtimeTuiState(state, {
      type: "transcript_done",
      role: "assistant",
      text: "ready",
    });
    state = reduceRealtimeTuiState(state, {
      type: "item_added",
      item: { type: "message", id: "item_1" },
    });

    const output = await renderToString(<RealtimePanel state={state} />, 100);

    expect(output).toContain("transport webrtc");
    expect(output).toContain("voice default");
    expect(output).toContain("model realtime");
    expect(output).toContain("mic muted");
    expect(output).toContain("[############]");
    expect(output).toContain("agenc");
    expect(output).toContain("ready");
    expect(output).toContain("item: message item_1");
    expect(output).toContain("[space]");
    expect(output).toContain("PTT");
  });

  test("keeps the status row within narrow terminal width", async () => {
    const longSessionId = "rt_session_with_a_very_long_identifier_that_must_not_overflow";
    let state = reduceRealtimeTuiState(initialRealtimeTuiState(), {
      type: "start_requested",
      transport: "websocket",
    });
    state = reduceRealtimeTuiState(state, {
      type: "started",
      realtimeSessionId: longSessionId,
    });
    state = reduceRealtimeTuiState(state, {
      type: "local_audio_level",
      peak: 65535,
    });
    state = reduceRealtimeTuiState(state, {
      type: "push_to_talk_changed",
      enabled: true,
    });

    const parts = getRealtimeStatusRenderParts(state, 32);
    expect(stringWidth(`${parts.statusText}${parts.meterText ?? ""}`)).toBeLessThanOrEqual(32);
    expect(parts.statusText).not.toContain(longSessionId);

    const output = await renderToString(<RealtimePanel state={state} />, 32);
    const widestLine = Math.max(...output.split("\n").map(line => stringWidth(line.trimEnd())));
    expect(widestLine).toBeLessThanOrEqual(32);
  });

  test("renders error and closed terminal banners", async () => {
    const failed = reduceRealtimeTuiState(initialRealtimeTuiState(), {
      type: "error",
      message: "microphone denied",
    });
    const closed = reduceRealtimeTuiState(initialRealtimeTuiState(), {
      type: "closed",
      reason: "requested",
    });

    await expect(renderToString(<RealtimePanel state={failed} />, 100)).resolves
      .toContain("microphone denied");
    await expect(renderToString(<RealtimePanel state={closed} />, 100)).resolves
      .toContain("Realtime closed: requested");
  });
});
