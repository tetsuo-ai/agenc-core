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

vi.mock("../ink.js", () => ({
  render: harness.renderInk,
}));

vi.mock("../components/App.js", () => ({
  AgenCTuiApp: harness.app,
}));

vi.mock("../backpressure.js", () => ({
  recordTuiBackpressure: harness.recordTuiBackpressure,
}));

import {
  bootTUI,
  handleStdinLoss,
  STDIN_LOSS_FLUSH_FALLBACK_MS,
  type StdinLossSession,
} from "../main.js";

type MockStdin = EventEmitter & {
  isTTY: boolean;
  setRawMode?: ReturnType<typeof vi.fn>;
};

type MockWriteStream = EventEmitter & {
  isTTY: boolean;
  writes: string[];
  write: ReturnType<typeof vi.fn>;
};

type RenderedTuiElement = {
  readonly props: {
    readonly isInteractive: boolean;
    readonly initialUserMessages?: readonly unknown[];
  };
};

function createStdin(options: {
  readonly isTTY?: boolean;
  readonly setRawMode?: ReturnType<typeof vi.fn>;
} = {}): MockStdin {
  const stream = new EventEmitter() as MockStdin;
  stream.isTTY = options.isTTY ?? true;
  if (options.setRawMode !== undefined) {
    stream.setRawMode = options.setRawMode;
  }
  return stream;
}

function createWriteStream(
  writeImpl?: (chunk: string | Uint8Array) => boolean,
): MockWriteStream {
  const stream = new EventEmitter() as MockWriteStream;
  stream.isTTY = true;
  stream.writes = [];
  stream.write = vi.fn((chunk: string | Uint8Array) => {
    stream.writes.push(String(chunk));
    return writeImpl?.(chunk) ?? true;
  });
  return stream;
}

function exitWithError(code: number): never {
  throw new Error(`exit:${code}`);
}

describe("TUI main swarm coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.exitCallback = undefined;
  });

  test("cleans up listeners, raw mode, and exit hooks when Ink render rejects", async () => {
    const setRawMode = vi.fn();
    const stdin = createStdin({ setRawMode });
    const stdout = createWriteStream();
    const stderr = createWriteStream();
    const renderError = new Error("render failed");
    harness.renderInk.mockRejectedValue(renderError);

    await expect(
      bootTUI({
        session: {} as never,
        configStore: {} as never,
        stdin: stdin as never,
        stdout: stdout as never,
        stderr: stderr as never,
      }),
    ).rejects.toBe(renderError);

    expect(setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(setRawMode).toHaveBeenNthCalledWith(2, false);
    expect(stdin.listenerCount("close")).toBe(0);
    expect(stdin.listenerCount("end")).toBe(0);
    expect(stdin.listenerCount("error")).toBe(0);
    expect(harness.onExitUnsubscribe).toHaveBeenCalledTimes(1);
    expect(stdout.write).toHaveBeenCalledTimes(5);
  });

  test("continues render cleanup when raw-mode release and terminal restore throw", async () => {
    const setRawMode = vi.fn((enabled: boolean) => {
      if (!enabled) throw new Error("raw release failed");
    });
    const stdin = createStdin({ setRawMode });
    const stdout = createWriteStream(() => {
      throw new Error("restore failed");
    });
    const renderError = new Error("render failed after raw claim");
    harness.renderInk.mockRejectedValue(renderError);

    await expect(
      bootTUI({
        session: {} as never,
        configStore: {} as never,
        stdin: stdin as never,
        stdout: stdout as never,
        stderr: createWriteStream() as never,
      }),
    ).rejects.toBe(renderError);

    expect(setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(setRawMode).toHaveBeenNthCalledWith(2, false);
    expect(stdout.write).toHaveBeenCalledTimes(1);
    expect(harness.onExitUnsubscribe).toHaveBeenCalledTimes(1);
  });

  test("skips startup raw mode for non-TTY input and marks the app noninteractive", async () => {
    const stdin = createStdin({ isTTY: false });
    const initialUserMessages = [{ role: "user", content: "hello" }];
    harness.renderInk.mockResolvedValue({
      unmount: vi.fn(),
      waitUntilExit: vi.fn(async () => undefined),
    });

    await bootTUI({
      session: {} as never,
      configStore: {} as never,
      stdin: stdin as never,
      stdout: createWriteStream() as never,
      stderr: createWriteStream() as never,
      initialUserMessages: initialUserMessages as never,
    });

    expect(stdin.setRawMode).toBeUndefined();
    const [element] = harness.renderInk.mock.calls[0] as [RenderedTuiElement];
    expect(element.props.isInteractive).toBe(false);
    expect(element.props.initialUserMessages).toBe(initialUserMessages);
  });

  test("uses fallback stdin-loss delay and unstructured warnings without internal ids", async () => {
    const setTimeoutMock = vi.fn(
      (callback: () => void, _durationMs: number) => {
        callback();
        return {} as NodeJS.Timeout;
      },
    );
    const session = {
      abortTerminal: vi.fn(() => {
        throw new Error("abort failed");
      }),
      emit: vi.fn(),
    };
    const unmountInk = vi.fn();

    await expect(
      handleStdinLoss(
        session as unknown as StdinLossSession,
        unmountInk,
        {
          exit: exitWithError,
          setTimeoutFn: setTimeoutMock as unknown as typeof setTimeout,
        },
      ),
    ).rejects.toThrow("exit:130");

    expect(setTimeoutMock).toHaveBeenCalledWith(
      expect.any(Function),
      STDIN_LOSS_FLUSH_FALLBACK_MS,
    );
    expect(session.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "warning:stdin_lost",
        cause: "stdin_lost",
        message:
          "stdin was lost while the TUI was active; aborting the session",
      }),
    );
    expect(unmountInk).toHaveBeenCalledTimes(1);
  });

  test("continues stdin-loss shutdown when flush, emit, and unmount handlers fail", async () => {
    const session = {
      abortTerminal: vi.fn(),
      flushEventLog: vi.fn(() => {
        throw new Error("flush failed");
      }),
      emit: vi.fn(() => {
        throw new Error("emit failed");
      }),
    };
    const unmountInk = vi.fn(() => {
      throw new Error("unmount failed");
    });

    await expect(
      handleStdinLoss(
        session as unknown as StdinLossSession,
        unmountInk,
        { exit: exitWithError },
      ),
    ).rejects.toThrow("exit:130");

    expect(session.flushEventLog).toHaveBeenCalledTimes(1);
    expect(session.emit).toHaveBeenCalledTimes(1);
    expect(unmountInk).toHaveBeenCalledTimes(1);
  });

  test("accepts synchronous flush results and emits structured stdin-loss warnings", async () => {
    const timeoutHandle = { unref: vi.fn() };
    const setTimeoutMock = vi.fn(
      (_callback: () => void, _durationMs: number) =>
        timeoutHandle as unknown as NodeJS.Timeout,
    );
    const session = {
      flushEventLog: vi.fn(() => undefined),
      emit: vi.fn(),
      nextInternalSubId: vi.fn(() => "warning-1"),
    };

    await expect(
      handleStdinLoss(
        session as unknown as StdinLossSession,
        vi.fn(),
        {
          exit: exitWithError,
          setTimeoutFn: setTimeoutMock as unknown as typeof setTimeout,
        },
      ),
    ).rejects.toThrow("exit:130");

    expect(timeoutHandle.unref).toHaveBeenCalledTimes(1);
    expect(session.emit).toHaveBeenCalledWith({
      id: "warning-1",
      msg: {
        type: "warning",
        payload: {
          cause: "stdin_lost",
          message:
            "stdin was lost while the TUI was active; aborting the session",
          timestamp: expect.any(Number),
        },
      },
    });
  });
});
