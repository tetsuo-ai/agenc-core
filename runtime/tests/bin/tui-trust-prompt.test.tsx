import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  renderInk: vi.fn(),
  unmount: vi.fn(),
}));

vi.mock("../tui/ink.js", () => ({
  render: harness.renderInk,
}));

import { CURSOR_HOME, ERASE_SCREEN } from "../tui/ink/termio/csi.js";
import { renderProjectTrustPrompt } from "./tui-trust-prompt.js";

class TestReadStream extends EventEmitter {
  isTTY = true;
}

class TestWriteStream extends EventEmitter {
  isTTY = true;
  readonly writes: string[] = [];
  write = vi.fn((chunk: string | Uint8Array) => {
    this.writes.push(String(chunk));
    return true;
  });
}

describe("renderProjectTrustPrompt", () => {
  it("clears the accepted trust prompt before the main TUI renders", async () => {
    const stdin = new TestReadStream();
    const stdout = new TestWriteStream();
    const stderr = new TestWriteStream();
    harness.renderInk.mockImplementationOnce(async (element) => {
      queueMicrotask(() => {
        (element as { readonly props: { readonly finish: (accepted: boolean) => void } })
          .props.finish(true);
      });
      return {
        unmount: harness.unmount,
        waitUntilExit: async () => new Promise<never>(() => {}),
      };
    });

    await expect(
      renderProjectTrustPrompt({
        workspaceRoot: "/tmp/project",
        stdin: stdin as never,
        stdout: stdout as never,
        stderr: stderr as never,
      }),
    ).resolves.toBe(true);

    expect(harness.unmount).toHaveBeenCalledTimes(1);
    expect(stdout.writes).toContain(ERASE_SCREEN + CURSOR_HOME);
  });

  it("does not clear when trust is rejected", async () => {
    const stdin = new TestReadStream();
    const stdout = new TestWriteStream();
    const stderr = new TestWriteStream();
    harness.renderInk.mockImplementationOnce(async (element) => {
      queueMicrotask(() => {
        (element as { readonly props: { readonly finish: (accepted: boolean) => void } })
          .props.finish(false);
      });
      return {
        unmount: harness.unmount,
        waitUntilExit: async () => new Promise<never>(() => {}),
      };
    });

    await expect(
      renderProjectTrustPrompt({
        workspaceRoot: "/tmp/project",
        stdin: stdin as never,
        stdout: stdout as never,
        stderr: stderr as never,
      }),
    ).resolves.toBe(false);

    expect(stdout.writes).not.toContain(ERASE_SCREEN + CURSOR_HOME);
  });
});
