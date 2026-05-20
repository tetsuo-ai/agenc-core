import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

import App from "./App.js";
import { createSelectionState } from "../selection.js";

type TestStream = NodeJS.ReadStream & NodeJS.WriteStream;

function stream(): TestStream {
  const s = new PassThrough() as TestStream;
  s.isTTY = false;
  s.write = vi.fn(() => true) as never;
  return s;
}

function appProps(overrides: Partial<ConstructorParameters<typeof App>[0]> = {}): ConstructorParameters<typeof App>[0] {
  return {
    children: null,
    stdin: stream(),
    stdout: stream(),
    stderr: stream(),
    exitOnCtrlC: true,
    onExit: () => {},
    terminalColumns: 80,
    terminalRows: 24,
    selection: createSelectionState(),
    onSelectionChange: () => {},
    onClickAt: () => false,
    onHoverAt: () => {},
    getHyperlinkAt: () => undefined,
    onOpenHyperlink: () => {},
    onMultiClick: () => {},
    onSelectionDrag: () => {},
    dispatchKeyboardEvent: () => {},
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Ink App stdin recovery coverage", () => {
  test("reattaches the data listener when processing a resumed stdin chunk throws", () => {
    vi.useFakeTimers();
    vi.setSystemTime(6_001);
    vi.stubEnv("DISABLE_ERROR_REPORTING", "1");

    const stdin = stream();
    const onStdinResume = vi.fn();
    const app = new App(appProps({ stdin, onStdinResume }));
    const error = new Error("parser failed");

    app.rawModeEnabledCount = 1;
    app.lastStdinTime = 1_000;
    vi.spyOn(app, "processInput").mockImplementation(() => {
      throw error;
    });

    expect(stdin.listeners("data")).not.toContain(app.handleDataChunk);

    app.handleDataChunk("input");

    expect(onStdinResume).toHaveBeenCalledOnce();
    expect(app.lastStdinTime).toBe(6_001);
    expect(app.processInput).toHaveBeenCalledWith("input");
    expect(stdin.listeners("data")).toContain(app.handleDataChunk);
  });
});
