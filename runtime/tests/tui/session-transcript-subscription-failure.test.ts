import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import { expect, it, vi } from "vitest";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { DaemonEventReplay } from "../../src/tui/daemon-event-replay.js";
import { createRoot } from "../../src/tui/ink/root.js";
import { useSessionTranscript } from "../../src/tui/session-transcript.js";
import type { AgenCBridgeSession } from "../../src/tui/session-types.js";

it("shows a replay-gap error and cleans transcript subscriptions and timers", async () => {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn(),
  });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 140, rows: 30 });
  const stderr = new PassThrough();
  const frames: string[] = [];
  stdout.on("data", chunk => frames.push(String(chunk)));
  stderr.resume();
  const timeout = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const unsubscribeLog = vi.fn();
  let coalescingTimer: ReturnType<typeof setTimeout> | undefined;
  const replay = new DaemonEventReplay(1);
  replay.publish("retained");
  replay.publish("gap");
  const session: AgenCBridgeSession = {
    conversationId: "replay-gap-session",
    services: { permissionModeRegistry: { current: () => createEmptyToolPermissionContext() } },
    eventLog: {
      subscribe: callback => {
        callback({ id: "pending", msg: { type: "agent_message_delta", payload: { delta: "pending" } } });
        expect(timeout.mock.lastCall?.[1]).toBe(33);
        coalescingTimer = timeout.mock.results.at(-1)?.value;
        return unsubscribeLog;
      },
    },
    subscribeToEvents: callback => replay.subscribe(callback),
  };
  function Probe(): null {
    useSessionTranscript(session);
    return null;
  }
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
  });
  const exit = root.waitUntilExit().catch(error => error);
  try {
    root.render(React.createElement(Probe));
    await vi.waitFor(() => expect(unsubscribeLog).toHaveBeenCalledOnce());
    expect(coalescingTimer).toBeDefined();
    expect(clear).toHaveBeenCalledWith(coalescingTimer);
    await vi.waitFor(() => {
      const display = stripVTControlCharacters(frames.join("")).replace(/\s+/g, "");
      expect(display).toContain("Reopenthisconversation");
    });
    expect(replay.size).toBe(0);
  } finally {
    root.unmount();
    await exit;
    stdin.end();
    stdout.end();
    stderr.end();
    timeout.mockRestore();
    clear.mockRestore();
    consoleError.mockRestore();
  }
});
