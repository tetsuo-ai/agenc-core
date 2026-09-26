import { describe, expect, it } from "vitest";

import {
  beginExecutingToolCall,
  isToolCallPhysicallyExecuting,
} from "../../src/session/executing-tool-calls.js";

function sessionWithTurn(controller: AbortController | null = new AbortController()) {
  return {
    activeTurn: {
      unsafePeek(): { abortController: AbortController } | null {
        return controller === null ? null : { abortController: controller };
      },
    },
  };
}

describe("isToolCallPhysicallyExecuting", () => {
  it("is true only for the live turn that began the same call", () => {
    const turn = new AbortController();
    const session = sessionWithTurn(turn);
    const finish = beginExecutingToolCall(session, "call_1");

    expect(isToolCallPhysicallyExecuting(session, "call_1", turn)).toBe(true);
    expect(isToolCallPhysicallyExecuting(session, "call_2", turn)).toBe(false);
    expect(isToolCallPhysicallyExecuting({}, "call_1", turn)).toBe(false);
    expect(isToolCallPhysicallyExecuting(session, "call_1", new AbortController())).toBe(false);

    finish();
    expect(isToolCallPhysicallyExecuting(session, "call_1", turn)).toBe(false);
  });

  it("is false after the turn or the call signal is aborted", () => {
    const turn = new AbortController();
    const call = new AbortController();
    const session = sessionWithTurn(turn);
    beginExecutingToolCall(session, "call_1", call.signal);

    expect(isToolCallPhysicallyExecuting(session, "call_1", turn)).toBe(true);
    call.abort();
    expect(isToolCallPhysicallyExecuting(session, "call_1", turn)).toBe(false);

    const laterTurn = new AbortController();
    const laterSession = sessionWithTurn(laterTurn);
    beginExecutingToolCall(laterSession, "call_2");
    laterTurn.abort();
    expect(isToolCallPhysicallyExecuting(laterSession, "call_2", laterTurn)).toBe(false);
  });

  it("does not treat a finished handle as still executing after the same id starts again", () => {
    const firstTurn = new AbortController();
    const session = sessionWithTurn(firstTurn);
    const finishFirst = beginExecutingToolCall(session, "call_1");

    const secondTurn = new AbortController();
    session.activeTurn.unsafePeek = () => ({ abortController: secondTurn });
    const finishSecond = beginExecutingToolCall(session, "call_1");

    finishFirst();
    expect(isToolCallPhysicallyExecuting(session, "call_1", firstTurn)).toBe(false);
    expect(isToolCallPhysicallyExecuting(session, "call_1", secondTurn)).toBe(true);
    finishSecond();
    expect(isToolCallPhysicallyExecuting(session, "call_1", secondTurn)).toBe(false);
  });

  it("never reports a call that began without a live turn", () => {
    const session = sessionWithTurn(null);
    beginExecutingToolCall(session, "call_1");
    expect(isToolCallPhysicallyExecuting(session, "call_1", new AbortController())).toBe(false);
  });
});
