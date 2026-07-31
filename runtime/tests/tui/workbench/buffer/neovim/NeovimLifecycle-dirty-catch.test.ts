import { describe, expect, it } from "vitest";
import { EmbeddedNeovimSession } from "../../../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";

// M-TUI-5: isDirty() and the quit path called #rpc.request with
// no catch. The transport can close independently of the session (stdin EPIPE
// before the child's exit), so during that window :q/:wq and buffer:close (which
// await isDirty()) must contain the RPC rejection instead of letting an
// unhandled rejection take down the daemon. Only an already-exited child is
// treated as not-dirty; a live child with unknown state fails closed.

function makeSession(): EmbeddedNeovimSession {
  const rpc = {
    // Every request rejects, simulating a closed transport.
    request: async () => {
      throw new Error("transport closed");
    },
    close: () => {},
  };
  const child = {
    // No real process backs this transport-only fixture. PID 1 is a dangerous
    // sentinel here because POSIX process-group cleanup interprets -1 as a
    // broadcast, so model the missing child explicitly instead.
    pid: 0,
    exitCode: 0, // already exited -> waitForNeovimExit resolves immediately
    signalCode: null,
    stdin: { end: () => {} },
  };
  const handle = { pid: 0, child, kill: () => {} };
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
