import { describe, expect, test, vi } from "vitest";

import type {
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
} from "../../app-server/protocol/index.js";
import type { RealtimeAudioPlayer } from "./audio.js";
import { createRealtimeTuiControls } from "./controller.js";

function createClient(): {
  readonly requests: Array<{
    readonly method: AgenCDaemonMethod;
    readonly params?: JsonObject;
  }>;
  request<Method extends AgenCDaemonMethod>(
    method: Method,
    params?: JsonObject,
  ): Promise<AgenCDaemonResultByMethod[Method]>;
} {
  const requests: Array<{
    readonly method: AgenCDaemonMethod;
    readonly params?: JsonObject;
  }> = [];
  return {
    requests,
    async request(method, params) {
      requests.push({ method, params });
      return {} as AgenCDaemonResultByMethod[typeof method];
    },
  };
}

describe("AgenC realtime TUI controller coverage", () => {
  test("sanitizes transcript notifications while best-effort cleaning up remote errors", async () => {
    const client = createClient();
    const emitted: JsonObject[] = [];
    const stopCapture = vi.fn(async () => {
      throw new Error("capture stop is best effort");
    });
    const audioPlayer: RealtimeAudioPlayer = {
      enqueue: vi.fn(),
      close: vi.fn(),
    };
    const controls = createRealtimeTuiControls({
      threadId: "thread-105",
      client,
      emitEvent: (event) => emitted.push(event),
      startAudioCapture: async () => ({ stop: stopCapture }),
      audioPlayer,
    });
    const snapshots: string[] = [];
    const unsubscribe = controls.subscribe((state) => {
      snapshots.push(
        [
          state.phase,
          state.localAudioLevel,
          state.lastItemSummary ?? "",
          state.errorBanner ?? "",
        ].join("|"),
      );
    });

    controls.handleTranscriptEvent(null);
    controls.handleTranscriptEvent({ type: 105, payload: { peak: 65_535 } });
    controls.handleTranscriptEvent({
      type: "realtime_output_audio_delta",
      payload: { audio: { data: "AAAA", sampleRate: 24_000 } },
    });
    controls.handleTranscriptEvent({
      type: "realtime_item_added",
      payload: "not an object",
    });
    controls.handleTranscriptEvent({
      type: "realtime_local_audio_level",
      payload: { peak: 321.6 },
    });

    expect(audioPlayer.enqueue).not.toHaveBeenCalled();
    expect(controls.getState()).toMatchObject({
      lastItemSummary: "null",
      localAudioLevel: 322,
    });

    await controls.start({ transport: "websocket" });
    controls.handleTranscriptEvent({
      type: "realtime_error",
      payload: "not an object",
    });
    await Promise.resolve();
    unsubscribe();

    expect(stopCapture).toHaveBeenCalledTimes(1);
    expect(audioPlayer.close).toHaveBeenCalledTimes(1);
    expect(controls.getState()).toMatchObject({
      phase: "inactive",
      errorBanner: "Realtime error",
    });
    expect(emitted).toEqual([]);
    expect(snapshots).toContain("inactive|322|null|");
    expect(client.requests.map((request) => request.method)).toEqual([
      "thread/realtime/start",
    ]);
  });
});
