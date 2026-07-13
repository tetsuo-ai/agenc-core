import { describe, expect, it } from "vitest";
import { EmbeddedNeovimSession } from "../../../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";

// M-TUI-5 (core-todo.md): isDirty() and the quit path called #rpc.request with
// no catch. The transport can close independently of the session (stdin EPIPE
// before the child's exit), so during that window :q/:wq and buffer:close (which
// await isDirty()) let the RPC rejection escape as an unhandled rejection that
// can take down the daemon. A dead transport is now treated as not-dirty.

function makeSession(): EmbeddedNeovimSession {
  const rpc = {
    // Every request rejects, simulating a closed transport.
    request: async () => {
      throw new Error("transport closed");
    },
    close: () => {},
  };
  const child = {
    pid: 1,
    exitCode: 0, // already exited -> waitForNeovimExit resolves immediately
    signalCode: null,
    stdin: { end: () => {} },
  };
  const handle = { pid: 1, child, kill: () => {} };
  const ui = { dispose: () => {} };
  return new EmbeddedNeovimSession(
    handle as never,
    rpc as never,
    ui as never,
    5,
  );
}

describe("EmbeddedNeovimSession — dead-transport dirty check", () => {
  it("isDirty() resolves false instead of rejecting when the transport is closed", async () => {
    await expect(makeSession().isDirty()).resolves.toBe(false);
  });

  it("quit() closes cleanly instead of leaking the dirty-check rejection", async () => {
    // Without the catch, #quitWithDirtyCheck's `await this.isDirty()` rejects and
    // quit() rejects — the exact unhandled rejection the fix prevents.
    await expect(makeSession().quit(false)).resolves.toEqual({ closed: true });
  });
});
