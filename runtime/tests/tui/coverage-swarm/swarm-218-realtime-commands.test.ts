import { describe, expect, test, vi } from "vitest";

import type { AgenCRealtimeTuiControls } from "../../../src/tui/realtime/controller.js";
import {
  executeRealtimeComposerCommand,
  parseRealtimeComposerCommand,
} from "../../../src/tui/realtime/commands.js";

function createControls(
  phase: ReturnType<AgenCRealtimeTuiControls["getState"]>["phase"] =
    "inactive",
): AgenCRealtimeTuiControls {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    appendText: vi.fn(async () => {}),
    appendAudio: vi.fn(async () => {}),
    setMuted: vi.fn(),
    setPushToTalk: vi.fn(),
    setPushToTalkHeld: vi.fn(),
    getState: vi.fn(() => ({ phase })),
    subscribe: vi.fn(),
    handleTranscriptEvent: vi.fn(),
  } as unknown as AgenCRealtimeTuiControls;
}

describe("realtime composer commands coverage swarm row 218", () => {
  test("parses command aliases and rejects empty text payloads", () => {
    expect(parseRealtimeComposerCommand("  /realtime start  ")).toEqual({
      kind: "start",
      transport: "websocket",
    });
    expect(parseRealtimeComposerCommand("/realtime stop")).toEqual({
      kind: "stop",
    });
    expect(parseRealtimeComposerCommand("/realtime mute")).toEqual({
      kind: "mute",
      muted: true,
    });
    expect(parseRealtimeComposerCommand("/realtime unmute")).toEqual({
      kind: "mute",
      muted: false,
    });
    expect(parseRealtimeComposerCommand("/realtime ptt")).toEqual({
      kind: "push_to_talk",
      enabled: true,
    });
    expect(parseRealtimeComposerCommand("/realtime ptt off")).toEqual({
      kind: "push_to_talk",
      enabled: false,
    });
    expect(parseRealtimeComposerCommand("/realtime ptt release")).toEqual({
      kind: "push_to_talk_held",
      held: false,
    });
    expect(parseRealtimeComposerCommand("/realtime text      ")).toBeNull();
    expect(parseRealtimeComposerCommand("/realtime-status")).toBeNull();
  });

  test("executes websocket start and push-to-talk aliases", async () => {
    const controls = createControls();

    await expect(
      executeRealtimeComposerCommand(controls, "/realtime start"),
    ).resolves.toBe(true);
    expect(controls.start).toHaveBeenCalledWith({ transport: "websocket" });

    await expect(
      executeRealtimeComposerCommand(controls, "/realtime ptt"),
    ).resolves.toBe(true);
    expect(controls.setPushToTalk).toHaveBeenCalledWith(true);

    await expect(
      executeRealtimeComposerCommand(controls, "/realtime ptt off"),
    ).resolves.toBe(true);
    expect(controls.setPushToTalk).toHaveBeenCalledWith(false);

    await expect(
      executeRealtimeComposerCommand(controls, "/realtime ptt release"),
    ).resolves.toBe(true);
    expect(controls.setPushToTalkHeld).toHaveBeenCalledWith(false);
  });

  test("toggles inactive controls on and active controls off", async () => {
    const inactiveControls = createControls("inactive");
    await expect(
      executeRealtimeComposerCommand(inactiveControls, "/realtime"),
    ).resolves.toBe(true);
    expect(inactiveControls.start).toHaveBeenCalledWith({
      transport: "websocket",
    });
    expect(inactiveControls.stop).not.toHaveBeenCalled();

    const activeControls = createControls("active");
    await expect(
      executeRealtimeComposerCommand(activeControls, "/realtime"),
    ).resolves.toBe(true);
    expect(activeControls.stop).toHaveBeenCalledTimes(1);
    expect(activeControls.start).not.toHaveBeenCalled();
  });

  test("leaves non-realtime input and missing controls unhandled", async () => {
    const controls = createControls();

    await expect(
      executeRealtimeComposerCommand(controls, "/realtime-status"),
    ).resolves.toBe(false);
    expect(controls.start).not.toHaveBeenCalled();
    expect(controls.stop).not.toHaveBeenCalled();

    await expect(
      executeRealtimeComposerCommand(undefined, "/realtime mute"),
    ).resolves.toBe(false);
  });
});
