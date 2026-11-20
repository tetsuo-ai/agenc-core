import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REPLACED_MODEL_CALL_SETTLE_MS,
  ReplacedModelCalls,
  holdReplacementWhileOnWire,
} from "../../src/session/replaced-model-call.js";

/** A provider request that stays out until the test answers it. */
function pendingRequest<T>() {
  let answer!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { answer = resolve; fail = reject; });
  return { promise, answer, fail };
}

/** A turn whose model call is on the wire, in a session that tracks replaced calls. */
function callOnWire(calls: ReplacedModelCalls | undefined = new ReplacedModelCalls()) {
  const turn = new AbortController();
  const call = holdReplacementWhileOnWire(turn.signal, calls);
  const request = pendingRequest<string>();
  const sent = call.onWire(() => request.promise);
  sent.catch(() => undefined);
  return { turn, call, request, sent, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a replacement waits for a model call already on the wire", () => {
  it("holds a replaced turn's call until it settles, and the replacement waits for it", async () => {
    const { turn, call, request, sent, calls } = callOnWire();
    calls!.armWhile(() => turn.abort("replaced"));
    expect(call.signal.aborted).toBe(false);
    expect(calls!.size).toBe(1);
    let replacementWaited = false;
    const replacement = calls!.wait().then(() => { replacementWaited = true; });
    await Promise.resolve();
    expect(replacementWaited).toBe(false);

    request.answer("answer with usage");
    await expect(sent).resolves.toBe("answer with usage");
    // The admitted call settled its usage; the turn now stops on the abort.
    call.release();
    expect(call.signal.aborted).toBe(true);
    expect(call.signal.reason).toBe("replaced");
    await replacement;
    expect(replacementWaited).toBe(true);
    expect(calls!.size).toBe(0);
  });

  it("holds only for the session's own armed replacement", () => {
    // A sub-agent's turn copies its parent's `replaced` reason; nothing in its
    // own session waits for its call, so it is cut at once.
    const { turn, call, calls } = callOnWire();
    turn.abort("replaced");
    expect(call.signal.aborted).toBe(true);
    expect(calls!.size).toBe(0);
    // And a session that tracks nothing holds nothing.
    const untracked = callOnWire(undefined);
    untracked.turn.abort("replaced");
    expect(untracked.call.signal.aborted).toBe(true);
  });

  it("cuts at once when the turn is replaced before the call goes out or after it came back", async () => {
    const calls = new ReplacedModelCalls();
    const before = new AbortController();
    let early!: ReturnType<typeof holdReplacementWhileOnWire>;
    calls.armWhile(() => {
      before.abort("replaced");
      early = holdReplacementWhileOnWire(before.signal, calls);
    });
    expect(early.signal.aborted).toBe(true);

    const between = new AbortController();
    const call = holdReplacementWhileOnWire(between.signal, calls);
    await call.onWire(async () => "first attempt");
    calls.armWhile(() => between.abort("replaced"));
    expect(call.signal.aborted).toBe(true);
    expect(calls.size).toBe(0);
  });

  it.each(["interrupted", "daemon_shutdown", "review_ended", new Error("stream idle")])(
    "cuts a call on the wire at once for %s",
    (reason) => {
      const { turn, call, calls } = callOnWire();
      calls!.armWhile(() => turn.abort(reason));
      expect(call.signal.aborted).toBe(true);
      expect(call.signal.reason).toBe(reason);
      expect(calls!.size).toBe(0);
    },
  );

  it("lets any other stop of the session cut a held call at once, with its own reason", async () => {
    const { turn, call, calls } = callOnWire();
    calls!.armWhile(() => turn.abort("replaced"));
    const replacement = calls!.wait();
    calls!.cutAll("interrupted");
    expect(call.signal.aborted).toBe(true);
    expect(call.signal.reason).toBe("interrupted");
    await replacement;
    expect(calls!.size).toBe(0);

    const session = new AbortController();
    const shutdown = callOnWire(new ReplacedModelCalls(session.signal));
    shutdown.calls!.armWhile(() => shutdown.turn.abort("replaced"));
    expect(shutdown.call.signal.aborted).toBe(false);
    session.abort("daemon_shutdown");
    expect(shutdown.call.signal.aborted).toBe(true);
    expect(shutdown.call.signal.reason).toBe("daemon_shutdown");
  });

  it("stops holding when the held request fails, so no retry goes out", async () => {
    const { turn, call, request, sent, calls } = callOnWire();
    calls!.armWhile(() => turn.abort("replaced"));
    expect(call.signal.aborted).toBe(false);
    request.fail(new Error("connection reset"));
    await expect(sent).rejects.toThrow("connection reset");
    expect(call.signal.aborted).toBe(true);
    expect(calls!.size).toBe(0);
  });

  it("cuts a held call that does not settle within the bound", async () => {
    vi.useFakeTimers();
    const { turn, call, calls } = callOnWire();
    calls!.armWhile(() => turn.abort("replaced"));
    const replacement = calls!.wait();
    await vi.advanceTimersByTimeAsync(REPLACED_MODEL_CALL_SETTLE_MS - 1);
    expect(call.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.signal.aborted).toBe(true);
    await replacement;
    expect(calls!.size).toBe(0);
  });
});
