import { describe, expect, test, vi } from "vitest";

import type { AgenCRealtimeTuiControls } from "./controller.js";
import {
  executeRealtimeComposerCommand,
  parseRealtimeComposerCommand,
} from "./commands.js";

function createControls(): AgenCRealtimeTuiControls {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    appendText: vi.fn(async () => {}),
    appendAudio: vi.fn(async () => {}),
    setMuted: vi.fn(),
    setPushToTalk: vi.fn(),
    setPushToTalkHeld: vi.fn(),
    getState: vi.fn(),
    subscribe: vi.fn(),
    handleTranscriptEvent: vi.fn(),
  } as unknown as AgenCRealtimeTuiControls;
}

describe("AgenC realtime composer commands", () => {
  test("parses realtime command aliases without matching longer slash commands", () => {
    expect(parseRealtimeComposerCommand("/realtime")).toEqual({
      kind: "start",
      transport: "websocket",
    });
    expect(parseRealtimeComposerCommand("/realtime start")).toEqual({
      kind: "start",
      transport: "websocket",
    });
    expect(parseRealtimeComposerCommand("/realtime webrtc")).toEqual({
      kind: "start",
      transport: "webrtc",
    });
    expect(parseRealtimeComposerCommand("/realtime start webrtc")).toEqual({
      kind: "start",
      transport: "webrtc",
    });
    expect(parseRealtimeComposerCommand("/realtime text  hello  ")).toEqual({
      kind: "text",
      text: "hello",
    });
    expect(parseRealtimeComposerCommand("/realtimeoops")).toBeNull();
    expect(parseRealtimeComposerCommand("/realtime text   ")).toBeNull();
    expect(parseRealtimeComposerCommand("/realtime unknown")).toBeNull();
  });

  test("executes realtime composer controls and consumes commands without controls", async () => {
    const controls = createControls();

    await expect(
      executeRealtimeComposerCommand(controls, "/realtime webrtc"),
    ).resolves.toBe(true);
    expect(controls.start).toHaveBeenCalledWith({ transport: "webrtc" });

    await executeRealtimeComposerCommand(controls, "/realtime mute");
    expect(controls.setMuted).toHaveBeenCalledWith(true);

    await executeRealtimeComposerCommand(controls, "/realtime unmute");
    expect(controls.setMuted).toHaveBeenCalledWith(false);

    await executeRealtimeComposerCommand(controls, "/realtime ptt on");
    expect(controls.setPushToTalk).toHaveBeenCalledWith(true);

    await executeRealtimeComposerCommand(controls, "/realtime ptt hold");
    expect(controls.setPushToTalkHeld).toHaveBeenCalledWith(true);

    await executeRealtimeComposerCommand(controls, "/realtime text hi");
    expect(controls.appendText).toHaveBeenCalledWith("hi");

    await executeRealtimeComposerCommand(controls, "/realtime stop");
    expect(controls.stop).toHaveBeenCalled();

    await expect(
      executeRealtimeComposerCommand(undefined, "/realtime stop"),
    ).resolves.toBe(true);
    await expect(
      executeRealtimeComposerCommand(controls, "ordinary message"),
    ).resolves.toBe(false);
  });
});
