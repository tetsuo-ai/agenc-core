import { PassThrough } from "node:stream";
import React from "react";
import { expect, test, vi } from "vitest";
import { Text } from "../../../src/tui/ink.js";
import { createRoot } from "../../../src/tui/ink/root.js";
import { getInkInstance } from "../../../src/tui/ink/instances.js";

test.each([false, true])("unmount preserves queued user input only for session handoff: %s", async preserve => {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 180, rows: 50 });
  stdout.resume();
  const root = await createRoot({ stdin: stdin as never, stdout: stdout as never,
    patchConsole: false, shouldPreserveInputOnExit: () => preserve });
  const renderer = getInkInstance(stdout as never)!;
  root.render(<Text>Old large transcript</Text>);
  // Input can arrive while the final old frame renders, before unmount drains.
  const drain = vi.spyOn(renderer, "drainStdin");
  stdin.setEncoding("utf8");
  stdin.push("New prompt while session switches 😅");
  try {
    root.unmount();
    expect(drain).toHaveBeenCalledTimes(preserve ? 0 : 1);
    expect(stdin.read()).toBe(preserve ? "New prompt while session switches 😅" : null);
  } finally {
    drain.mockRestore();
    root.unmount();
    stdin.destroy(); stdout.destroy();
  }
});
