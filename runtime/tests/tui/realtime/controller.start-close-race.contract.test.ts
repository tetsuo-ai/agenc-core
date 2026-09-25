import { beforeEach, describe, expect, test, vi } from "vitest";

const logMock = vi.hoisted(() => ({
  logError: vi.fn(),
}));

vi.mock("../../utils/log.js", () => ({
  logError: logMock.logError,
}));

import type {
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
} from "../../app-server/protocol/index.js";
import type { StartRealtimeAudioCapture } from "./audio.js";
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

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${message}`);
}

// Sessions that end while realtime start is still in flight must not leave a
// live microphone capture behind or reject start().
describe("AgenC realtime TUI controller start/close race", () => {
  beforeEach(() => {
    logMock.logError.mockReset();
  });

  test.each([
    {
      type: "realtime_closed",
      payload: { reason: "remote closed" },
      expected: { closedBanner: "Realtime closed: remote closed" },
    },
    {
      type: "realtime_error",
      payload: { message: "provider failed" },
      expected: { errorBanner: "provider failed" },
    },
  ])(
    "does not open the mic when $type arrives during the start RPC",
    async ({ type, payload, expected }) => {
      const requests: Array<{
        readonly method: AgenCDaemonMethod;
        readonly params?: JsonObject;
      }> = [];
      let controls: ReturnType<typeof createRealtimeTuiControls> | null = null;
      let closeDuringStart = true;
      const client = {
        requests,
        async request<Method extends AgenCDaemonMethod>(
          method: Method,
          params?: JsonObject,
        ): Promise<AgenCDaemonResultByMethod[Method]> {
          requests.push({ method, params });
          if (method === "thread/realtime/start" && closeDuringStart) {
            // The session ends before the start RPC resolves.
            closeDuringStart = false;
            controls?.handleTranscriptEvent({ type, payload });
          }
          return {} as AgenCDaemonResultByMethod[Method];
        },
      };
      const stop = vi.fn();
      const startAudioCapture = vi.fn<StartRealtimeAudioCapture>(
        async () => ({ stop }),
      );
      controls = createRealtimeTuiControls({
        threadId: "agent_1",
        client,
        emitEvent: () => {},
        startAudioCapture,
      });

      await expect(
        controls.start({ transport: "websocket" }),
      ).resolves.toBeUndefined();

      expect(startAudioCapture).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(controls.getState()).toMatchObject({
        phase: "inactive",
        localAudioLevel: 0,
        ...expected,
      });
      expect(
        requests.some(
          (request) => request.method === "thread/realtime/appendAudio",
        ),
      ).toBe(false);

      // A fresh start still opens exactly one capture for the new session.
      await controls.start({ transport: "websocket" });
      expect(startAudioCapture).toHaveBeenCalledTimes(1);
      expect(controls.getState().phase).toBe("starting");
      await controls.stop();
      expect(stop).toHaveBeenCalledTimes(1);
    },
  );

  test("logs a synchronous stop throw from a capture discarded after close", async () => {
    const discardError = new Error("sync stale capture stop failed");
    const client = createClient();
    let releaseCapture: (() => void) | null = null;
    const stop = vi.fn(() => {
      throw discardError;
    });
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: () => {},
      startAudioCapture: async () => {
        await new Promise<void>((resolve) => {
          releaseCapture = resolve;
        });
        return { stop };
      },
    });

    const start = controls.start({ transport: "websocket" });
    await waitFor(() => releaseCapture !== null, "capture start pending");
    controls.handleTranscriptEvent({
      type: "realtime_closed",
      payload: { reason: "remote closed" },
    });
    releaseCapture?.();

    await expect(start).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(logMock.logError).toHaveBeenCalledWith(discardError);
    expect(controls.getState()).toMatchObject({
      phase: "inactive",
      errorBanner: null,
      closedBanner: "Realtime closed: remote closed",
    });
  });
});
