import { describe, expect, test, vi } from "vitest";

import type { IPty } from "../../src/pty/loadPty.js";
import { signalPtyProcessTree } from "../../src/pty/process-tree.js";

// node-pty's kill() is process.kill(this.pid, signal). For pid 0 that signals
// the caller's own process group, for -1 every process the user owns, and
// for 1 init. A PTY without a pid above 1 must never be signalled. The PTYs
// here are stand-ins whose kill() is a spy.

function ptyWithPid(pid: number): IPty & { kill: ReturnType<typeof vi.fn> } {
  return { pid, kill: vi.fn() } as unknown as IPty & {
    kill: ReturnType<typeof vi.fn>;
  };
}

describe("signalPtyProcessTree", () => {
  test.each([0, -1, 1, Number.NaN, 2.5])(
    "refuses pid %s without signalling anything",
    (pid) => {
      const pty = ptyWithPid(pid);
      // Never calls through: a real kill with these pids is the hazard.
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      try {
        expect(signalPtyProcessTree(pty, "SIGTERM", { exited: false })).toBe(false);
        expect(signalPtyProcessTree(pty, "SIGKILL", { exited: false })).toBe(false);
        expect(pty.kill).not.toHaveBeenCalled();
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    },
  );
});
