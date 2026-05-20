import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = {
    exitCallback: undefined as (() => void) | undefined,
    app: vi.fn(() => null),
    onExitUnsubscribe: vi.fn(),
    renderInk: vi.fn(),
    recordTuiBackpressure: vi.fn(),
    onExit: undefined as unknown as (callback: () => void) => () => void,
  };
  state.onExit = vi.fn((callback: () => void) => {
    state.exitCallback = callback;
    return state.onExitUnsubscribe;
  });
  return state;
});

vi.mock("signal-exit", () => ({
  onExit: harness.onExit,
}));

vi.mock("./ink.js", () => ({
  render: harness.renderInk,
}));

vi.mock("./components/App.js", () => ({
  AgenCTuiApp: harness.app,
}));

vi.mock("./backpressure.js", () => ({
  recordTuiBackpressure: harness.recordTuiBackpressure,
}));

import {
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
} from "./ink/termio/csi.js";
import {
  DISABLE_MOUSE_TRACKING,
  EXIT_ALT_SCREEN,
  SHOW_CURSOR,
} from "./ink/termio/dec.js";
import {
  bootTUI,
  RENDER_BACKPRESSURE_THRESHOLD_MS,
} from "./main.js";
import { AgenCTuiApp } from "./components/App.js";

class TestReadStream extends EventEmitter {
  isTTY = true;
  setRawMode = vi.fn();
}

class TestWriteStream extends EventEmitter {
  isTTY = true;
  readonly writes: string[] = [];
  write = vi.fn((chunk: string | Uint8Array) => {
    this.writes.push(String(chunk));
    return true;
  });
}

type RenderedTuiElement = {
  readonly type: unknown;
  readonly props: {
    readonly session: unknown;
    readonly configStore: unknown;
    readonly isInteractive: boolean;
    readonly model?: unknown;
    readonly initialPrompt?: string;
    readonly initialComposerText?: string;
    readonly getFpsMetrics: () => unknown;
  };
};

type RenderOptions = {
  readonly stdin: unknown;
  readonly stdout: unknown;
  readonly stderr: unknown;
  readonly patchConsole: boolean;
  readonly exitOnCtrlC: boolean;
  readonly onFrame: (event: { readonly durationMs: number }) => void;
};

describe("TUI main coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.exitCallback = undefined;
  });

  test("bootTUI wires Ink startup, render backpressure, and terminal restoration", async () => {
    const stdin = new TestReadStream();
    const stdout = new TestWriteStream();
    const stderr = new TestWriteStream();
    const session = { id: "session-1" };
    const configStore = { source: "test" };
    const unmount = vi.fn();
    const waitUntilExit = vi.fn(async () => undefined);

    harness.renderInk.mockResolvedValue({ unmount, waitUntilExit });

    const handle = await bootTUI({
      session: session as never,
      configStore: configStore as never,
      stdin: stdin as never,
      stdout: stdout as never,
      stderr: stderr as never,
      model: "model-for-test" as never,
      initialPrompt: "start here",
      initialComposerText: "draft prompt",
    });

    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(harness.onExit).toHaveBeenCalledTimes(1);
    expect(stdin.listenerCount("close")).toBe(1);
    expect(stdin.listenerCount("end")).toBe(1);
    expect(stdin.listenerCount("error")).toBe(1);

    expect(harness.renderInk).toHaveBeenCalledTimes(1);
    const [element, renderOptions] = harness.renderInk.mock
      .calls[0] as [RenderedTuiElement, RenderOptions];
    expect(element.type).toBe(AgenCTuiApp);
    expect(element.props.session).toBe(session);
    expect(element.props.configStore).toBe(configStore);
    expect(element.props.isInteractive).toBe(true);
    expect(element.props.model).toBe("model-for-test");
    expect(element.props.initialPrompt).toBe("start here");
    expect(element.props.initialComposerText).toBe("draft prompt");
    expect(element.props.getFpsMetrics()).toBeUndefined();

    expect(renderOptions).toMatchObject({
      stdin,
      stdout,
      stderr,
      patchConsole: true,
      exitOnCtrlC: false,
    });

    renderOptions.onFrame({
      durationMs: RENDER_BACKPRESSURE_THRESHOLD_MS - 1,
    });
    expect(harness.recordTuiBackpressure).not.toHaveBeenCalled();

    renderOptions.onFrame({
      durationMs: RENDER_BACKPRESSURE_THRESHOLD_MS,
    });
    expect(harness.recordTuiBackpressure).toHaveBeenCalledWith({
      source: "render",
      durationMs: RENDER_BACKPRESSURE_THRESHOLD_MS,
    });
    expect(element.props.getFpsMetrics()).toMatchObject({
      sampleCount: 2,
    });

    await expect(handle.waitUntilExit()).resolves.toBeUndefined();
    expect(waitUntilExit).toHaveBeenCalledTimes(1);

    handle.unmount();
    expect(unmount).toHaveBeenCalledTimes(1);

    harness.exitCallback?.();
    expect(stdout.write).toHaveBeenNthCalledWith(1, EXIT_ALT_SCREEN);
    expect(stdout.write).toHaveBeenNthCalledWith(2, DISABLE_MOUSE_TRACKING);
    expect(stdout.write).toHaveBeenNthCalledWith(3, DISABLE_KITTY_KEYBOARD);
    expect(stdout.write).toHaveBeenNthCalledWith(4, DISABLE_MODIFY_OTHER_KEYS);
    expect(stdout.write).toHaveBeenNthCalledWith(5, SHOW_CURSOR);
  });
});
