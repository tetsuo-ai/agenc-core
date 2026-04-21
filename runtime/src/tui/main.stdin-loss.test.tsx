/**
 * T12 Wave 5-B — I-19 stdin-loss protocol coverage.
 *
 * Tests exercise the three stdin-death events (`close`, `end`, `error`)
 * against `bootTUI`'s wiring, then drop down to `handleStdinLoss` to
 * cover the `flushEventLog` branches (present + absent) in isolation.
 *
 * `process.exit` is spied so the handler can complete without tearing
 * the test harness down.
 */

import { PassThrough } from "node:stream";
import { describe, expect, test, vi, afterEach } from "vitest";

import {
  STDIN_LOSS_FLUSH_FALLBACK_MS,
  bootTUI,
  handleStdinLoss,
  type StdinLossSession,
} from "./main.js";
import instances from "./ink/instances.js";
import type { ConfigStoreLike } from "./state/AppState.js";

function makeSession(overrides: Partial<StdinLossSession> = {}): StdinLossSession {
  const baseRegistry = {
    current: () => ({ mode: "default" as const }),
    subscribeToModeChange: () => () => undefined,
  };
  return {
    services: { permissionModeRegistry: baseRegistry },
    abortTerminal: vi.fn(),
    emit: vi.fn(),
    nextInternalSubId: () => "sub-stdin-loss",
    ...overrides,
  };
}

function configStore(): ConfigStoreLike {
  return {};
}

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function createStreams(): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

afterEach(() => {
  // Every bootTUI() call registers an Ink instance keyed by stdout.
  // Clear the registry so subsequent mounts start fresh.
  for (const stdout of Array.from(instances.keys())) {
    instances.delete(stdout);
  }
});

/**
 * Drive a stdin event through bootTUI and return the session mocks so
 * the test can assert on abortTerminal / emit / unmount side effects.
 */
async function bootAndFire(event: "close" | "end" | "error") {
  const { stdout, stdin } = createStreams();
  const abortTerminal = vi.fn();
  const emit = vi.fn();
  const session = makeSession({ abortTerminal, emit });

  // process.exit(130) MUST not kill the test runner. Stub it; the
  // handler returns normally after the stubbed exit call.
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(((_code?: number) => undefined) as never);

  try {
    const handle = await bootTUI({
      session,
      configStore: configStore(),
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    stdin.emit(event, event === "error" ? new Error("stdin lost") : undefined);

    // The handler is async (the stdin listener is sync-scheduled but
    // the protocol body is async). Drain microtasks so abortTerminal's
    // synchronous call site has a chance to fire.
    await Promise.resolve();
    await Promise.resolve();

    return { session, exitSpy, unmount: handle.unmount };
  } catch (err) {
    exitSpy.mockRestore();
    throw err;
  }
}

describe("bootTUI stdin-loss wiring (I-19)", () => {
  test("stdin 'close' triggers abortTerminal('stdin_lost')", async () => {
    const { session, exitSpy, unmount } = await bootAndFire("close");
    expect(session.abortTerminal).toHaveBeenCalledWith("stdin_lost");
    unmount();
    exitSpy.mockRestore();
  });

  test("stdin 'error' triggers abortTerminal('stdin_lost')", async () => {
    const { session, exitSpy, unmount } = await bootAndFire("error");
    expect(session.abortTerminal).toHaveBeenCalledWith("stdin_lost");
    unmount();
    exitSpy.mockRestore();
  });

  test("stdin 'end' triggers abortTerminal('stdin_lost')", async () => {
    const { session, exitSpy, unmount } = await bootAndFire("end");
    expect(session.abortTerminal).toHaveBeenCalledWith("stdin_lost");
    unmount();
    exitSpy.mockRestore();
  });

  test("initialPrompt submits one turn after boot", async () => {
    const { stdout, stdin } = createStreams();
    const session = makeSession({
      submit: vi.fn(async () => undefined),
    });

    const handle = await bootTUI({
      session,
      configStore: configStore(),
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      initialPrompt: "queue this",
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(session.submit).toHaveBeenCalledTimes(1);
    expect(session.submit).toHaveBeenCalledWith("queue this");

    handle.unmount();
    instances.delete(stdout as unknown as NodeJS.WriteStream);
    stdin.end();
    stdout.end();
  });
});

describe("handleStdinLoss — flush barrier (I-19 step 2)", () => {
  test("awaits flushEventLog when present before exiting 130", async () => {
    const exitSpy = vi.fn() as unknown as (code: number) => never;
    let flushResolved = false;
    const flushEventLog = vi.fn(async () => {
      // Give the handler a tick to observe that exit is still pending.
      await new Promise<void>((r) => setImmediate(r));
      flushResolved = true;
    });
    const session = makeSession({ flushEventLog });
    const unmount = vi.fn();

    await handleStdinLoss(session, unmount, { exit: exitSpy });

    expect(flushEventLog).toHaveBeenCalledTimes(1);
    expect(flushResolved).toBe(true);
    expect(session.emit).toHaveBeenCalledWith({
      id: "sub-stdin-loss",
      msg: {
        type: "warning",
        payload: expect.objectContaining({
          cause: "stdin_lost",
        }),
      },
    });
    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(unmount).toHaveBeenCalledTimes(1);
  });

  test("falls back to 200ms grace when flushEventLog is absent (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const exitSpy = vi.fn() as unknown as (code: number) => never;
      const session = makeSession(); // no flushEventLog
      const unmount = vi.fn();

      const pending = handleStdinLoss(session, unmount, { exit: exitSpy });

      // Let the synchronous abort step run before we advance time.
      await Promise.resolve();
      // Advancing anything less than the fallback must NOT trigger exit.
      await vi.advanceTimersByTimeAsync(STDIN_LOSS_FLUSH_FALLBACK_MS - 1);
      expect(exitSpy).not.toHaveBeenCalled();

      // Crossing the threshold finishes the sequence.
      await vi.advanceTimersByTimeAsync(2);
      await pending;
      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(unmount).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
