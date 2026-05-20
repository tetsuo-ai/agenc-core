import { describe, expect, test, vi } from "vitest";

vi.mock("./ink.js", () => ({
  render: vi.fn(),
}));

vi.mock("./components/App.js", () => ({
  AgenCTuiApp: vi.fn(() => null),
}));

import {
  handleStdinLoss,
  STDIN_LOSS_FLUSH_HARD_CAP_MS,
  type StdinLossSession,
} from "./main.js";

describe("TUI main stdin loss coverage", () => {
  test("flushes session state, emits a structured warning, unmounts, and exits", async () => {
    const timeoutHandle = { unref: vi.fn() };
    const setTimeoutMock = vi.fn(
      (_callback: () => void, _durationMs: number) =>
        timeoutHandle as unknown as NodeJS.Timeout,
    );
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    let resolveFlush!: () => void;
    const flushPromise = new Promise<void>((resolve) => {
      resolveFlush = resolve;
    });
    const session = {
      abortTerminal: vi.fn(),
      flushEventLog: vi.fn(() => flushPromise),
      emit: vi.fn(),
      nextInternalSubId: vi.fn(() => "internal-warning-1"),
    };
    const unmountInk = vi.fn(() => {
      throw new Error("already unmounted");
    });

    const result = handleStdinLoss(
      session as unknown as StdinLossSession,
      unmountInk,
      {
        exit,
        setTimeoutFn: setTimeoutMock as unknown as typeof setTimeout,
      },
    );

    await Promise.resolve();

    expect(session.abortTerminal).toHaveBeenCalledWith("stdin_lost");
    expect(session.flushEventLog).toHaveBeenCalledTimes(1);
    expect(setTimeoutMock).toHaveBeenCalledWith(
      expect.any(Function),
      STDIN_LOSS_FLUSH_HARD_CAP_MS,
    );
    expect(timeoutHandle.unref).toHaveBeenCalledTimes(1);

    resolveFlush();
    await expect(result).rejects.toThrow("exit:130");

    expect(session.nextInternalSubId).toHaveBeenCalledTimes(1);
    expect(session.emit).toHaveBeenCalledWith({
      id: "internal-warning-1",
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
    expect(unmountInk).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });
});
