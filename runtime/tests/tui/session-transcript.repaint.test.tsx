import { PassThrough } from "node:stream";
import React from "react";
import { expect, test, vi } from "vitest";
import { Text } from "../../src/tui/ink.js";
import { createRoot } from "../../src/tui/ink/root.js";
import instances, { getInkInstance } from "../../src/tui/ink/instances.js";
import { useSessionTranscript } from "../../src/tui/session-transcript.js";
import type { AgenCBridgeSession } from "../../src/tui/session-types.js";

test("repaints the physical terminal after an authoritative history replacement", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void; ref: () => void; unref: () => void };
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = new PassThrough();
  Object.assign(stdout, { isTTY: true, columns: 180, rows: 50 });
  stdout.resume();
  let emit: ((event: unknown) => void) | undefined;
  const session = { initialTranscriptEvents: [], subscribeToEvents(callback: (event: unknown) => void) {
    emit = callback;
    return () => { emit = undefined; };
  } } as unknown as AgenCBridgeSession;
  function Probe() {
    const transcript = useSessionTranscript(session);
    return <Text>{transcript.messages.map(message => message.message?.content ?? "").join(" ")}</Text>;
  }
  const root = await createRoot({ stdin: stdin as never, stdout: stdout as never, patchConsole: false });
  const renderer = getInkInstance(stdout as never)!;
  const previous = instances.get(process.stdout);
  instances.set(process.stdout, renderer);
  const repaint = vi.spyOn(renderer, "forceRedraw");
  const settle = () => new Promise(resolve => setTimeout(resolve, 40));
  try {
    root.render(<Probe />);
    await settle();
    emit!({ id: "initial-empty-history", type: "history_replaced", payload: { reason: "partial_compact", messages: [] } });
    await settle();
    expect(repaint).not.toHaveBeenCalled();
    emit!({ id: "ordinary", type: "agent_message", payload: { message: "Old completed command" } });
    await settle();
    expect(repaint).not.toHaveBeenCalled();
    emit!({ id: "compact-replacement", type: "history_replaced", payload: { reason: "partial_compact", messages: [] } });
    await settle();
    expect(repaint).toHaveBeenCalledOnce();
    emit!({ id: "next-turn", type: "agent_message", payload: { message: "New ordinary turn" } });
    await settle();
    expect(repaint).toHaveBeenCalledOnce();
    emit!({ id: "clear-replacement", type: "history_cleared", payload: {} });
    await settle();
    expect(repaint).toHaveBeenCalledTimes(2);
  } finally {
    repaint.mockRestore();
    root.unmount();
    if (previous) instances.set(process.stdout, previous);
    else instances.delete(process.stdout);
    stdin.end(); stdout.end();
  }
});
