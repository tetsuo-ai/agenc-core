import { describe, expect, it } from "vitest";

import { execFileNoThrow } from "../../src/utils/execFileNoThrow.js";

// execFileNoThrow:289 (core-todo.md): on timeout it called child.kill() (SIGTERM only)
// with no SIGKILL escalation. A child that traps/ignores SIGTERM never emits 'close', so
// the promise never settled and every awaiting caller hung past the timeout. Mirrors the
// ripgrep.ts SIGTERM->SIGKILL fix.

describe("execFileNoThrow — SIGKILL escalation on timeout", () => {
  it("settles even when the child traps SIGTERM", async () => {
    const start = Date.now();
    // Trap SIGTERM (no-op) and stay alive; SIGTERM alone won't kill it.
    const result = await execFileNoThrow(
      "node",
      ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1e9)"],
      { timeout: 500, preserveOutputOnError: true },
    );
    // Without the escalation this await never resolves (the test times out).
    expect(result.code).not.toBe(0);
    // Settled promptly after the SIGKILL grace, not hung for the process lifetime.
    expect(Date.now() - start).toBeLessThan(8_000);
  }, 20_000);
});
