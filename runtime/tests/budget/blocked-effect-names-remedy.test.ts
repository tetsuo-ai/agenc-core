import { describe, expect, it } from "vitest";

import {
  EFFECT_REVIEW_BLOCK_STOP,
  LiveEffectMutationBlockedError,
  assertNoLiveUnknownEffect,
  clearLiveEffectPoison,
  liveEffectRefusalsSinceReview,
  poisonLiveEffect,
  resolveLiveEffectPoison,
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

/**
 * Regression from Terminal-Bench trial `risk-scorer-replay__ViaB4mm` (#2501).
 *
 * One refused write poisoned an `agenc -p` run. The message told the model
 * to ask a user who did not exist, so it retried blocked tools for ~3.5
 * hours and ~$60 before the exact-repeat backstop fired. Unattended runs
 * stop on the first refusal; every run stops after a short streak.
 */
describe("gate refusals end the turn instead of livelocking (#2501)", () => {
  const identity = {
    callId: "call-write-1",
    toolName: "Write",
    runId: "conv-test",
    stepId: "tool:conv-test:call-write-1",
  };
  const refuse = (session: object): LiveEffectMutationBlockedError => {
    try {
      assertNoLiveUnknownEffect(session, "side-effecting");
    } catch (error) {
      if (error instanceof LiveEffectMutationBlockedError) return error;
      throw error;
    }
    throw new Error("expected the gate to refuse");
  };

  it("counts refusals per session and ends the turn at the streak limit", () => {
    const session = {};
    poisonLiveEffect(session, identity);

    const refusals: LiveEffectMutationBlockedError[] = [];
    for (let i = 0; i < EFFECT_REVIEW_BLOCK_STOP; i += 1) refusals.push(refuse(session));

    expect(refusals.map((error) => error.refusals)).toEqual([1, 2, 3]);
    expect(refusals.map((error) => error.endsTurn)).toEqual([false, false, true]);
    expect(refusals[2]?.message).toContain("refused 3 times in a row");
    expect(refusals[2]?.message).toContain("this turn stops now");
    // Earlier refusals keep the plain remedy text: the model gets a chance
    // to read it and ask before the turn is ended.
    expect(refusals[0]?.message).not.toContain("this turn stops now");
    expect(liveEffectRefusalsSinceReview(session)).toBe(3);
  });

  it("does not count idempotent dispatch as a refusal", () => {
    const session = {};
    poisonLiveEffect(session, identity);
    assertNoLiveUnknownEffect(session, "idempotent");
    expect(liveEffectRefusalsSinceReview(session)).toBe(0);
  });

  it("resets the streak when the poison is reviewed or cleared", () => {
    const session = {};
    poisonLiveEffect(session, identity);
    refuse(session);
    refuse(session);
    expect(resolveLiveEffectPoison(session, { callId: identity.callId })).toBe(1);
    expect(liveEffectRefusalsSinceReview(session)).toBe(0);
    expect(() => assertNoLiveUnknownEffect(session, "side-effecting")).not.toThrow();

    poisonLiveEffect(session, identity);
    refuse(session);
    clearLiveEffectPoison(session, identity);
    expect(liveEffectRefusalsSinceReview(session)).toBe(0);
  });

  it("stops an unattended run on the first refusal and never tells it to ask a user", () => {
    const session = { services: { runtimeOptions: { nonInteractive: true } } };
    poisonLiveEffect(session, identity);

    const error = refuse(session);
    expect(error.unattended).toBe(true);
    expect(error.refusals).toBe(1);
    expect(error.endsTurn).toBe(true);
    expect(error.message).toContain("Write");
    expect(error.message).toContain("nobody attached");
    expect(error.message).toContain("this turn stops now");
    expect(error.message).toContain("agenc state resolve-tool-call");
    expect(error.message).not.toContain("ask the user");
    expect(error.message).not.toContain("in the AgenC UI");
  });

  it("treats an attended session as interactive on the first refusal", () => {
    const session = { services: { runtimeOptions: { nonInteractive: false } } };
    poisonLiveEffect(session, identity);
    const error = refuse(session);
    expect(error.unattended).toBe(false);
    expect(error.endsTurn).toBe(false);
    expect(error.message).toContain("ask the user to run");
  });
});
