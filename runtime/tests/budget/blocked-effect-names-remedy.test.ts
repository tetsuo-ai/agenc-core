import { describe, expect, it } from "vitest";

import {
  LiveEffectMutationBlockedError,
  assertNoLiveUnknownEffect,
  poisonLiveEffect,
} from "./effect-settlement-supervisor.js";

/**
 * Regression from a live hardware-debugging session.
 *
 * A `write_stdin` call died mid-dispatch, the M4 gate poisoned the session,
 * and every later build/upload/edit was refused. The message named the
 * problem but not the cure, so the agent concluded the session was
 * unrecoverable and told the operator: "Please restart this chat/agent
 * session... nothing more can reach the device until that lock is cleared."
 *
 * `/resolve` clears the gate through the running daemon. Nobody had to
 * restart anything — the way out just was not in the text anyone read.
 */
describe("the blocked-effect error names its own remedy", () => {
  const identity = {
    callId: "call-abc123",
    toolName: "write_stdin",
    runId: "conv-test",
    stepId: "tool:conv-test:call-abc123",
  };

  it("tells the reader to run /resolve with the blocking call id", () => {
    const error = new LiveEffectMutationBlockedError([identity]);

    expect(error.message).toContain("write_stdin");
    expect(error.message).toContain("/resolve call-abc123");
    expect(error.message).toContain("confirmed_no_effect");
    expect(error.message).toMatch(/recoverable without restarting/i);
  });

  it("tells the model that only the user can run /resolve and not to retry", () => {
    const error = new LiveEffectMutationBlockedError([identity]);

    expect(error.message).toContain("only the user can clear it");
    expect(error.message).toContain("ask the user to run");
    expect(error.message).toContain("in the AgenC UI");
    expect(error.message).toContain("You cannot run /resolve yourself.");
    expect(error.message).toContain(
      "Do not retry the blocked tools until the user has run it.",
    );
  });

  it("is thrown for side-effecting dispatch once an effect is poisoned", () => {
    const session = {};
    poisonLiveEffect(session, identity);

    expect(() => assertNoLiveUnknownEffect(session, "side-effecting")).toThrow(
      LiveEffectMutationBlockedError,
    );
    // Idempotent tools stay allowed — they have no effect to settle.
    expect(() =>
      assertNoLiveUnknownEffect(session, "idempotent"),
    ).not.toThrow();
  });
});
