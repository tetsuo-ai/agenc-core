import React from "react";
import { describe, expect, test } from "vitest";

import { renderToString } from "../../utils/staticRender.js";
import { RealtimePanel } from "./RealtimePanel.js";
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

    expect(output).toContain("voice | active | webrtc | rt_1 | mic muted");
    expect(output).toContain("[############]");
    expect(output).toContain("assistant: ready");
    expect(output).toContain("item: message item_1");
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
