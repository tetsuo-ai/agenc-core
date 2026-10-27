import { PassThrough } from "node:stream";

import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/utils/config.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isAutoUpdaterDisabled: () => false,
}));
vi.mock("../../../src/bin/update-cli.js", () => ({
  checkAgenCUpdate: vi.fn(async () => ({ updateAvailable: false, currentVersion: "0.19.0", latestVersion: "0.17.0" })),
}));

import { createRoot } from "../../../src/tui/ink/root.js";
import { useStartupUpdate } from "../../../src/tui/hooks/useStartupUpdate.js";

// Live on RC4.6: the startup update check put a raw process.stdin "data"
// listener next to Ink's "readable" reader. After /resume the TUI paused and
// resumed stdin, the stream kept flowing to that listener only, and the
// composer never received another key. The check must track typing through
// Ink, never by listening on process.stdin itself.

function fakeStreams() {
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
  stdout.resume();
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, ref() {}, unref() {}, setRawMode() {},
  });
  return { stdin, stdout };
}

const originalStdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
afterEach(() => {
  if (originalStdinTTY) Object.defineProperty(process.stdin, "isTTY", originalStdinTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  if (originalStdoutTTY) Object.defineProperty(process.stdout, "isTTY", originalStdoutTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

describe("useStartupUpdate", () => {
  test("never adds its own listener to process.stdin", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const before = process.stdin.listenerCount("data") + process.stdin.listenerCount("readable");
    const { stdin, stdout } = fakeStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    const configStore = { current: () => ({}), stateRepository: undefined } as never;
    function Harness(): null {
      useStartupUpdate({ safe: true, configStore, setToolJSX: () => {} });
      return null;
    }
    try {
      root.render(<Harness />);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const during = process.stdin.listenerCount("data") + process.stdin.listenerCount("readable");
      expect(during).toBe(before);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
