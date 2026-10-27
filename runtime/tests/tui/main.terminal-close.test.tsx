import { EventEmitter } from "node:events";

import { afterEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  renderInk: vi.fn(),
  onExit: vi.fn(() => () => {}),
}));

vi.mock("signal-exit", () => ({ onExit: harness.onExit }));
vi.mock("./ink.js", () => ({ render: harness.renderInk }));
vi.mock("./components/App.js", () => ({ AgenCTuiApp: vi.fn(() => null) }));
vi.mock("./backpressure.js", () => ({ recordTuiBackpressure: vi.fn() }));

import { bootTUI } from "./main.js";

// Closing a terminal window sends SIGHUP and then ends stdin. Both must reach
// the session owner's close (it retires an unused daemon session) instead of
// ending the process first.

type MockStdin = EventEmitter & { isTTY: boolean; setRawMode: ReturnType<typeof vi.fn> };

function stdin(): MockStdin {
  const stream = new EventEmitter() as MockStdin;
  stream.isTTY = true;
  stream.setRawMode = vi.fn();
  return stream;
}

function output(): EventEmitter & { isTTY: boolean; write: ReturnType<typeof vi.fn> } {
  const stream = new EventEmitter() as EventEmitter & { isTTY: boolean; write: ReturnType<typeof vi.fn> };
  stream.isTTY = true;
  stream.write = vi.fn(() => true);
  return stream;
}

/** A mounted Ink instance whose exit the test controls. */
function mountedInk() {
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const instance = { unmount: vi.fn(() => finish()), waitUntilExit: vi.fn(() => exited) };
  harness.renderInk.mockResolvedValue(instance);
  return instance;
}

afterEach(() => {
  vi.restoreAllMocks();
  harness.renderInk.mockReset();
});

describe("closing the terminal under the TUI", () => {
  test("SIGHUP takes the orderly unmount, and its listener goes with the TUI", async () => {
    const instance = mountedInk();
    const before = process.listenerCount("SIGHUP");
    const handle = await bootTUI({
      session: {} as never,
      stdin: stdin() as never,
      stdout: output() as never,
      stderr: output() as never,
    });
    expect(process.listenerCount("SIGHUP")).toBe(before + 1);

    const onHangup = process.listeners("SIGHUP").at(-1) as () => void;
    onHangup();
    expect(instance.unmount).toHaveBeenCalledOnce();

    await handle.waitUntilExit();
    expect(process.listenerCount("SIGHUP")).toBe(before);
  });

  test("a lost terminal waits for the session owner's close before exiting", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    mountedInk();
    const input = stdin();
    let releaseClose!: () => void;
    const beforeTerminalLossExit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    );
    const handle = await bootTUI({
      session: { flushEventLog: () => undefined } as never,
      stdin: input as never,
      stdout: output() as never,
      stderr: output() as never,
      beforeTerminalLossExit,
    });

    input.emit("end");
    await vi.waitFor(() => expect(beforeTerminalLossExit).toHaveBeenCalledOnce());
    expect(exit).not.toHaveBeenCalled();

    releaseClose();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
    await handle.waitUntilExit();
  });
});
