import { describe, expect, test } from "vitest";
import { StreamingToolExecutor } from "./streaming-executor.js";
import { SHARED_READ, EXCLUSIVE, ToolCallRuntime } from "./concurrency.js";
import { routerFromRegistry } from "./router.js";
import { EventLog } from "../session/event-log.js";
import type { ToolRegistry, ToolDispatchResult } from "../tool-registry.js";
import type { LLMTool, LLMToolCall } from "../llm/types.js";
import type { Tool } from "./types.js";
import type { PreToolUseHook } from "./hooks.js";
import type { ToolUseBlock } from "../session/turn-state.js";

function makeBlock(id: string, name: string): ToolUseBlock {
  return { type: "tool_use", id, name, input: {} };
}
function makeCall(id: string, name: string, args = "{}"): LLMToolCall {
  return { id, name, arguments: args };
}
function registryFor(
  dispatch: (call: LLMToolCall) => Promise<ToolDispatchResult>,
  tools: Tool[] = [],
): ToolRegistry {
  return {
    tools,
    toLLMTools(): LLMTool[] {
      return [];
    },
    dispatch,
  };
}
function testTool(overrides: Partial<Tool> & { name: string }): Tool {
  return {
    description: "test",
    inputSchema: { type: "object" },
    execute: async () => ({ content: "" }),
    ...overrides,
  };
}
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  return Promise.race([
    p.then((value) => ({ ok: true as const, value })),
    new Promise<{ ok: false; reason: string }>((resolve) =>
      setTimeout(() => resolve({ ok: false, reason: `TIMEOUT(${label})` }), ms).unref?.(),
    ),
  ]);
}

describe("StreamingToolExecutor stuck-tool drain (turn-finalize bug)", () => {
  // ROOT-CAUSE REPRO: a tool whose dispatch promise never settles must not
  // hang getRemainingResults() forever. The per-tool execute timeout
  // (execution.ts withTimeoutAndAbort) only wraps `tool.execute`; the
  // surrounding dispatch pipeline + executor wait are unbounded, so a hung
  // dispatch pins the turn on `executeTools` -> getRemainingResults forever
  // (rollout: a Read tool_call_started with no tool_call_completed, turn
  // never finalizes). The executor must bound the drain so the turn always
  // finalizes.
  test("a never-settling tool dispatch still lets the drain terminate", async () => {
    const exec = new StreamingToolExecutor({
      // dispatch never resolves -> simulates a hang OUTSIDE the per-tool
      // execute timeout (e.g. a wedged pre-execute step or executor wait).
      registry: registryFor(() => new Promise<ToolDispatchResult>(() => {})),
      // bound the drain aggressively for the test
      maxToolDrainMs: 250,
    });
    (exec as unknown as { runToolUseFn?: unknown }).runToolUseFn = (
      call: LLMToolCall,
    ) => (exec as any).registry.dispatch(call);

    exec.setConcurrencyClassFor("Read", SHARED_READ);
    exec.addTool(makeBlock("r1", "Read"), makeCall("r1", "Read"));
    exec.dispatchPending();
    exec.close();

    const collected: Array<{ id: string; isError: boolean }> = [];
    const outcome = await withTimeout(
      (async () => {
        for await (const r of exec.getRemainingResults()) {
          collected.push({ id: r.toolCall.id, isError: r.result.isError === true });
        }
      })(),
      4000,
      "stuck-drain",
    );

    // The drain MUST terminate (the turn finalizes) rather than hang forever.
    expect(outcome.ok).toBe(true);
    // The stuck tool yields a synthetic error result so its tool_use block
    // gets a paired tool_result (the conversation invariant holds).
    expect(collected).toEqual([{ id: "r1", isError: true }]);
  });

  // HARDENING REPRO (per-tool deadline): a tool with timeoutBehavior:"tool"
  // (resolveTimeoutMs -> null: request-user-input / wait / monitor /
  // background — intentionally unbounded) must NOT be force-timed-out by the
  // drain backstop, even with a tiny maxToolDrainMs. The flat-bound version
  // killed these mid-flight (e.g. discarding the human's pending answer);
  // the per-tool deadline exempts them. Against the flat-bound code this test
  // REDDENS (the tool gets a synthetic timeout); with the per-tool fix it
  // passes (the tool stays executing until the real dispatch settles).
  test("a timeoutBehavior:'tool' (unbounded) tool is NOT force-timed-out", async () => {
    let releaseDispatch!: (r: ToolDispatchResult) => void;
    const dispatchGate = new Promise<ToolDispatchResult>((resolve) => {
      releaseDispatch = resolve;
    });
    const longTool = testTool({
      name: "request-user-input",
      timeoutBehavior: "tool", // resolveTimeoutMs -> null -> EXEMPT
    });
    const exec = new StreamingToolExecutor({
      registry: registryFor(() => dispatchGate, [longTool]),
      // tiny floor: a flat backstop would fire almost immediately.
      maxToolDrainMs: 200,
    });
    (exec as unknown as { runToolUseFn?: unknown }).runToolUseFn = (
      call: LLMToolCall,
    ) => (exec as any).registry.dispatch(call);
    exec.setConcurrencyClassFor("request-user-input", SHARED_READ);
    exec.addTool(
      makeBlock("u1", "request-user-input"),
      makeCall("u1", "request-user-input"),
    );
    exec.dispatchPending();
    exec.close();

    const collected: Array<{ id: string; isError: boolean }> = [];
    const drainDone = (async () => {
      for await (const r of exec.getRemainingResults()) {
        collected.push({ id: r.toolCall.id, isError: r.result.isError === true });
      }
    })();

    // Wait well past the tiny floor; a per-tool-exempt tool must still be
    // pending (no synthetic timeout yet).
    const earlyOutcome = await withTimeout(drainDone, 700, "exempt-no-timeout");
    expect(earlyOutcome.ok).toBe(false); // still draining — NOT force-completed
    expect(collected).toEqual([]); // no synthetic timeout result emitted

    // Now let the real dispatch settle; the drain finalizes with the real
    // (non-error) result, proving it was never force-timed-out.
    releaseDispatch({ content: "human answered", isError: false });
    const finalOutcome = await withTimeout(drainDone, 4000, "exempt-settles");
    expect(finalOutcome.ok).toBe(true);
    expect(collected).toEqual([{ id: "u1", isError: false }]);
  });

  // HARDENING REPRO (per-call timeout floor-raise): a tool whose resolved
  // timeout (here a per-call args.timeoutMs) far exceeds maxToolDrainMs must
  // NOT be killed before its own timeout + grace. With a 5s per-call timeout
  // and a 200ms floor, the effective deadline is max(200ms, 5s+60s) = 65s, so
  // the tool is still executing 700ms in. The flat-bound code would kill it at
  // 200ms.
  test("a per-call timeoutMs >> maxToolDrainMs is not killed before its own deadline", async () => {
    let releaseDispatch!: (r: ToolDispatchResult) => void;
    const dispatchGate = new Promise<ToolDispatchResult>((resolve) => {
      releaseDispatch = resolve;
    });
    const bashLike = testTool({ name: "system.bash" });
    const exec = new StreamingToolExecutor({
      registry: registryFor(() => dispatchGate, [bashLike]),
      maxToolDrainMs: 200,
    });
    (exec as unknown as { runToolUseFn?: unknown }).runToolUseFn = (
      call: LLMToolCall,
    ) => (exec as any).registry.dispatch(call);
    exec.setConcurrencyClassFor("system.bash", SHARED_READ);
    exec.addTool(
      makeBlock("b1", "system.bash"),
      // per-call timeout of 5s >> 200ms floor
      makeCall("b1", "system.bash", JSON.stringify({ timeoutMs: 5000 })),
    );
    exec.dispatchPending();
    exec.close();

    const collected: Array<{ id: string; isError: boolean }> = [];
    const drainDone = (async () => {
      for await (const r of exec.getRemainingResults()) {
        collected.push({ id: r.toolCall.id, isError: r.result.isError === true });
      }
    })();

    const earlyOutcome = await withTimeout(drainDone, 700, "longtimeout-no-kill");
    expect(earlyOutcome.ok).toBe(false); // still executing, NOT force-killed
    expect(collected).toEqual([]);

    releaseDispatch({ content: "ok", isError: false });
    const finalOutcome = await withTimeout(drainDone, 4000, "longtimeout-settles");
    expect(finalOutcome.ok).toBe(true);
    expect(collected).toEqual([{ id: "b1", isError: false }]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Cooperative cancellation of force-finalized wedged tools (release leg).
//
// PR #1318 force-finalizes a wedged tool (synthetic timeout) so the turn
// ends, but never cancels the underlying dispatch — its ToolCallRuntime lock
// / Semaphore permit / hook are abandoned (a silent cross-turn resource
// leak). These tests prove the new release leg: the backstop cooperatively
// CANCELS exactly that one tool's dispatch (via a per-tool listener-free
// drainCancel composed into the dispatch signal) so the lock/permit releases
// through its OWN existing finally — WITHOUT aborting siblings or bubbling to
// the parent turn — and honestly accounts (reclaimed vs leaked) for residue
// it cannot reclaim.
// ──────────────────────────────────────────────────────────────────────
describe("StreamingToolExecutor cooperative cancel of wedged tools", () => {
  // Drives an executor with a single tool to completion under a hard timeout,
  // collecting yielded results.
  async function drainSingle(
    exec: StreamingToolExecutor,
    timeoutMs: number,
    label: string,
  ): Promise<{
    outcome: { ok: true } | { ok: false; reason: string };
    collected: Array<{ id: string; isError: boolean }>;
  }> {
    const collected: Array<{ id: string; isError: boolean }> = [];
    const outcome = await withTimeout(
      (async () => {
        for await (const r of exec.getRemainingResults()) {
          collected.push({
            id: r.toolCall.id,
            isError: r.result.isError === true,
          });
        }
      })(),
      timeoutMs,
      label,
    );
    return { outcome: outcome.ok ? { ok: true } : outcome, collected };
  }

  // A cooperative wedged dispatch: never resolves on its own, but rejects when
  // its signal aborts (so its fn()-keyed finally — the lock/permit release —
  // runs). This is what a well-behaved abortable tool does.
  function cooperativeWedge(
    call: LLMToolCall,
    signal: AbortSignal,
  ): Promise<ToolDispatchResult> {
    return new Promise<ToolDispatchResult>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    });
  }

  // ── Test A — permit/lock RELEASED after force-cancel of a wedged holder.
  //    The acceptance criterion is "a sibling EXCLUSIVE can acquire the lock",
  //    NOT "the turn finalized". A wedged SHARED_READ holder pins readers > 0;
  //    a wedged EXCLUSIVE holder pins the write gate. After the force-cancel,
  //    the sibling EXCLUSIVE acquire must settle within a short timeout.
  for (const variant of [
    { kind: "shared_read", klass: SHARED_READ, name: "shared_read" },
    { kind: "exclusive", klass: EXCLUSIVE, name: "exclusive" },
  ] as const) {
    test(`force-cancel releases the runtime lock of a wedged ${variant.name} holder (sibling EXCLUSIVE acquires)`, async () => {
      const runtime = new ToolCallRuntime();
      const exec = new StreamingToolExecutor({
        registry: registryFor(() => new Promise<ToolDispatchResult>(() => {})),
        runtime,
        maxToolDrainMs: 200,
        cleanupGraceMs: 150,
      });
      (exec as unknown as { runToolUseFn?: unknown }).runToolUseFn = (
        call: LLMToolCall,
        signal: AbortSignal,
      ) => cooperativeWedge(call, signal);

      exec.setConcurrencyClassFor("wedged", variant.klass);
      exec.addTool(makeBlock("w1", "wedged"), makeCall("w1", "wedged"));
      exec.dispatchPending();
      exec.close();

      const { outcome, collected } = await drainSingle(exec, 4000, `relA-${variant.name}`);

      // (a) the turn finalizes with exactly one synthetic error result.
      expect(outcome.ok).toBe(true);
      expect(collected).toEqual([{ id: "w1", isError: true }]);

      // (b) the tool's dispatch unwound within the grace ⇒ reclaimed, no leak.
      const states = exec.getToolStates();
      const tracked = (exec as unknown as { tools: Array<{ id: string; outcome?: string }> }).tools.find(
        (t) => t.id === "w1",
      );
      expect(tracked?.outcome).toBe("reclaimed");
      expect(exec.leakedTools).toBe(0);
      expect(states.find((s) => s.id === "w1")?.status).toBe("yielded");

      // (c) THE KEY ASSERTION: a sibling EXCLUSIVE acquire on the SAME runtime
      //     resolves within a short timeout. If the wedged holder had not
      //     released (readers-- / write gate), the writer would starve forever.
      const acquire = await withTimeout(
        runtime.run(EXCLUSIVE, async () => "ok"),
        1000,
        "sibling-exclusive-acquire",
      );
      expect(acquire.ok).toBe(true);
      if (acquire.ok) expect(acquire.value).toBe("ok");
    });
  }

  // ── Test B — siblings + parent turn NOT aborted.
  //    One wedged cooperative tool + one healthy concurrent sibling. The
  //    healthy sibling still completes; the parent controller stays
  //    unaborted; onSiblingAbort was not called; and the wedged tool's
  //    childAbort was NOT aborted (drain-cancel did not reach it — one-way
  //    AbortSignal.any isolation).
  test("force-cancel does not abort siblings or the parent turn", async () => {
    const parentAbortController = new AbortController();
    let siblingAbortCalls = 0;
    let releaseHealthy!: (r: ToolDispatchResult) => void;
    const healthyGate = new Promise<ToolDispatchResult>((resolve) => {
      releaseHealthy = resolve;
    });

    const exec = new StreamingToolExecutor({
      registry: registryFor(() => new Promise<ToolDispatchResult>(() => {})),
      // 600ms drain floor so the healthy sibling (released at ~150ms) settles
      // with its REAL result well before the backstop fires; only the wedged
      // tool reaches its deadline and is force-cancelled.
      maxToolDrainMs: 600,
      cleanupGraceMs: 150,
      parentAbortController,
      onSiblingAbort: () => {
        siblingAbortCalls += 1;
      },
    });
    let wedgedSignal: AbortSignal | undefined;
    (exec as unknown as { runToolUseFn?: unknown }).runToolUseFn = (
      call: LLMToolCall,
      signal: AbortSignal,
    ) => {
      if (call.id === "w1") {
        wedgedSignal = signal;
        return cooperativeWedge(call, signal);
      }
      return healthyGate;
    };

    // Both SHARED_READ so they run concurrently.
    exec.setConcurrencyClassFor("wedged", SHARED_READ);
    exec.setConcurrencyClassFor("healthy", SHARED_READ);
    exec.addTool(makeBlock("w1", "wedged"), makeCall("w1", "wedged"));
    exec.addTool(makeBlock("h1", "healthy"), makeCall("h1", "healthy"));
    exec.dispatchPending();
    exec.close();

    const collected: Array<{ id: string; isError: boolean }> = [];
    const drainDone = (async () => {
      for await (const r of exec.getRemainingResults()) {
        collected.push({ id: r.toolCall.id, isError: r.result.isError === true });
      }
    })();

    // Resolve the healthy sibling EARLY (before the 600ms backstop) so it
    // finalizes with its real result; the wedged tool keeps holding until the
    // backstop force-cancels it.
    await new Promise((r) => setTimeout(r, 150).unref?.());
    releaseHealthy({ content: "healthy ok", isError: false });

    const outcome = await withTimeout(drainDone, 4000, "siblings-survive");
    expect(outcome.ok).toBe(true);

    // (a) the healthy sibling completed with its real (non-error) result.
    expect(collected).toContainEqual({ id: "h1", isError: false });
    // the wedged tool yielded a synthetic error.
    expect(collected).toContainEqual({ id: "w1", isError: true });

    // (b) the parent turn survives (drain-cancel did not bubble up).
    expect(parentAbortController.signal.aborted).toBe(false);
    // (c) onSiblingAbort was NOT called.
    expect(siblingAbortCalls).toBe(0);
    // (d) the wedged tool's dispatch DID observe abort (drainCancel reached the
    //     derived signal) — proving the cancel fired on the right channel — but
    //     NOT via childAbort: the derived signal is what aborts, while the
    //     parent/sibling controllers stay clean (asserted above).
    expect(wedgedSignal?.aborted).toBe(true);
  });

  // ── Test C — honest uncooperative leak (does NOT pretend to release).
  //    A wedged dispatch that IGNORES the signal cannot be reclaimed: the turn
  //    still finalizes with one synthetic cause:"timeout" result, but the tool
  //    is marked leaked, the counter increments, onLeakedTool fires once, and
  //    there is no unhandledRejection. We assert NO lock release for this case.
  test("uncooperative wedge is force-finalized and honestly marked leaked", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const leaked: Array<{ toolName: string; concurrencyKind: string; reason: string }> = [];
    const exec = new StreamingToolExecutor({
      registry: registryFor(() => new Promise<ToolDispatchResult>(() => {})),
      maxToolDrainMs: 150,
      cleanupGraceMs: 120,
      onLeakedTool: (info) => {
        leaked.push({
          toolName: info.toolName,
          concurrencyKind: info.concurrencyKind,
          reason: info.reason,
        });
      },
    });
    (exec as unknown as { runToolUseFn?: unknown }).runToolUseFn = () =>
      // Signal-blind: never resolves, never observes abort.
      new Promise<ToolDispatchResult>(() => {});

    exec.setConcurrencyClassFor("stubborn", SHARED_READ);
    exec.addTool(makeBlock("s1", "stubborn"), makeCall("s1", "stubborn"));
    exec.dispatchPending();
    exec.close();

    const { outcome, collected } = await drainSingle(exec, 4000, "uncoop-leak");

    // (a) the turn still finalizes with one synthetic timeout result.
    expect(outcome.ok).toBe(true);
    expect(collected).toEqual([{ id: "s1", isError: true }]);

    // Allow the grace race to classify the leak.
    await new Promise((r) => setTimeout(r, 250).unref?.());

    const tracked = (exec as unknown as { tools: Array<{ id: string; outcome?: string }> }).tools.find(
      (t) => t.id === "s1",
    );
    // (b) outcome leaked, (c) counter == 1.
    expect(tracked?.outcome).toBe("leaked");
    expect(exec.leakedTools).toBe(1);
    // (d) onLeakedTool fired once with the right identity.
    expect(leaked).toEqual([
      { toolName: "stubborn", concurrencyKind: "shared_read", reason: "tool timeout: drain exceeded" },
    ]);

    // Let any stray microtasks flush, then assert (e) no unhandledRejection.
    await new Promise((r) => setTimeout(r, 50).unref?.());
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  // ── Test D — late-settle no-op (idempotency). After force-finalize, a late
  //    dispatch resolution must be a strict no-op: exactly one result yielded,
  //    no status flip-back, and a late bash-class error does NOT re-abort
  //    siblings post-finalize.
  test("late settle after force-finalize is a strict no-op (non-error + bash isError)", async () => {
    for (const lateVariant of [
      { name: "late-nonerror", toolName: "lateread", isError: false },
      { name: "late-bash-error", toolName: "system.bash", isError: true },
    ] as const) {
      let releaseDispatch!: (r: ToolDispatchResult) => void;
      const gate = new Promise<ToolDispatchResult>((resolve) => {
        releaseDispatch = resolve;
      });
      let siblingAbortCalls = 0;

      const exec = new StreamingToolExecutor({
        registry: registryFor(() => new Promise<ToolDispatchResult>(() => {})),
        maxToolDrainMs: 200,
        cleanupGraceMs: 5000,
        bashToolName: "system.bash",
        onSiblingAbort: () => {
          siblingAbortCalls += 1;
        },
      });
      (exec as unknown as { runToolUseFn?: unknown }).runToolUseFn = () => gate;

      // SHARED_READ so the timeoutBehavior path is finite (no def -> floor).
      exec.setConcurrencyClassFor(lateVariant.toolName, SHARED_READ);
      exec.addTool(
        makeBlock("d1", lateVariant.toolName),
        makeCall("d1", lateVariant.toolName),
      );
      exec.dispatchPending();
      exec.close();

      const collected: Array<{ id: string; isError: boolean }> = [];
      const drainDone = (async () => {
        for await (const r of exec.getRemainingResults()) {
          collected.push({ id: r.toolCall.id, isError: r.result.isError === true });
        }
      })();

      // Force-finalize fires at ~200ms; the synthetic timeout is yielded.
      const outcome = await withTimeout(drainDone, 4000, lateVariant.name);
      expect(outcome.ok).toBe(true);

      // Now resolve the dispatch LATE (after finalize). This must be a no-op.
      releaseDispatch({ content: "late", isError: lateVariant.isError });
      await new Promise((r) => setTimeout(r, 100).unref?.());

      // (a) exactly ONE result yielded (the synthetic timeout, isError:true).
      expect(collected).toEqual([{ id: "d1", isError: true }]);
      // (b) status stayed yielded (no flip-back).
      const states = exec.getToolStates();
      expect(states.find((s) => s.id === "d1")?.status).toBe("yielded");
      // (c) the late bash error did NOT re-abort siblings post-finalize.
      expect(siblingAbortCalls).toBe(0);
    }
  });

  // ── Test E — interruptBehavior:'block' tool is still force-finalizable; a
  //    timeoutBehavior:'tool' tool is NOT. The drain kill is unconditional and
  //    does NOT consult getToolInterruptBehavior — it keys ONLY off
  //    toolDrainDeadlineMs. So a block-behavior tool with a finite
  //    (timeoutBehavior:'executor') deadline IS subject to the backstop, while
  //    the only exemption is the unbounded timeoutBehavior:'tool' deadline
  //    (toolDrainDeadlineMs -> Infinity). We assert this on the deadline
  //    computation the backstop actually keys off (white-box), so the proof is
  //    fast and exact rather than waiting out the multi-minute own+grace floor
  //    that a real registered tool's finite deadline carries.
  test("interruptBehavior:'block' has a finite drain deadline; timeoutBehavior:'tool' is exempt", async () => {
    const blockTool = testTool({
      name: "blocking-tool",
      interruptBehavior: () => "block",
      // timeoutBehavior defaults to "executor" -> finite deadline.
    });
    const exemptTool = testTool({
      name: "request-user-input",
      timeoutBehavior: "tool", // resolveTimeoutMs -> null -> EXEMPT (Infinity).
    });
    const exec = new StreamingToolExecutor({
      registry: registryFor(() => new Promise<ToolDispatchResult>(() => {}), [
        blockTool,
        exemptTool,
      ]),
      maxToolDrainMs: 150,
    });

    const internal = exec as unknown as {
      tools: Array<{
        toolCall: LLMToolCall;
        status: string;
        executingSinceMs?: number;
      }>;
      toolDrainDeadlineMs(tool: {
        toolCall: LLMToolCall;
        executingSinceMs?: number;
      }): number;
    };

    exec.setConcurrencyClassFor("blocking-tool", SHARED_READ);
    exec.setConcurrencyClassFor("request-user-input", SHARED_READ);
    exec.addTool(makeBlock("k1", "blocking-tool"), makeCall("k1", "blocking-tool"));
    exec.addTool(
      makeBlock("e1", "request-user-input"),
      makeCall("e1", "request-user-input"),
    );
    exec.dispatchPending();

    const blockTracked = internal.tools.find((t) => t.toolCall.id === "k1")!;
    const exemptTracked = internal.tools.find((t) => t.toolCall.id === "e1")!;

    // The block-behavior tool has a FINITE deadline -> subject to the backstop.
    const blockDeadline = internal.toolDrainDeadlineMs(blockTracked);
    expect(Number.isFinite(blockDeadline)).toBe(true);
    // The timeoutBehavior:'tool' tool is EXEMPT -> Infinity, never force-final.
    const exemptDeadline = internal.toolDrainDeadlineMs(exemptTracked);
    expect(exemptDeadline).toBe(Number.POSITIVE_INFINITY);

    exec.discard("teardown");
  });

  // ── Test E2 — runtime proof of the exemption: a timeoutBehavior:'tool' tool
  //    is NOT force-finalized even well past a tiny floor (mirrors the existing
  //    exemption test but inside the cooperative-cancel suite).
  test("timeoutBehavior:'tool' tool is NOT force-finalized at the drain floor", async () => {
    let releaseDispatch!: (r: ToolDispatchResult) => void;
    const gate = new Promise<ToolDispatchResult>((resolve) => {
      releaseDispatch = resolve;
    });
    const exemptTool = testTool({
      name: "request-user-input",
      timeoutBehavior: "tool",
    });
    const exec = new StreamingToolExecutor({
      registry: registryFor(() => gate, [exemptTool]),
      maxToolDrainMs: 150,
      cleanupGraceMs: 120,
    });
    (exec as unknown as { runToolUseFn?: unknown }).runToolUseFn = (
      call: LLMToolCall,
    ) => (exec as any).registry.dispatch(call);
    exec.setConcurrencyClassFor("request-user-input", SHARED_READ);
    exec.addTool(
      makeBlock("e1", "request-user-input"),
      makeCall("e1", "request-user-input"),
    );
    exec.dispatchPending();
    exec.close();

    const collected: Array<{ id: string; isError: boolean }> = [];
    const drainDone = (async () => {
      for await (const r of exec.getRemainingResults()) {
        collected.push({ id: r.toolCall.id, isError: r.result.isError === true });
      }
    })();
    // Well past the tiny floor: still draining, NOT force-completed.
    const early = await withTimeout(drainDone, 600, "exempt-not-forced");
    expect(early.ok).toBe(false);
    expect(collected).toEqual([]);
    releaseDispatch({ content: "answered", isError: false });
    const final = await withTimeout(drainDone, 4000, "exempt-settles");
    expect(final.ok).toBe(true);
    expect(collected).toEqual([{ id: "e1", isError: false }]);
  });

  // ── Test F — synthesized cause for a force-cancelled tool is pinned to
  //    "timeout". The decoded <tool_use_error> text must be the timeout text,
  //    catching any careless DRAIN_CANCEL_REASON / synthesis change.
  test("force-cancelled tool's synthesized cause is pinned to timeout", async () => {
    const exec = new StreamingToolExecutor({
      registry: registryFor(() => new Promise<ToolDispatchResult>(() => {})),
      maxToolDrainMs: 150,
      cleanupGraceMs: 120,
    });
    (exec as unknown as { runToolUseFn?: unknown }).runToolUseFn = (
      call: LLMToolCall,
      signal: AbortSignal,
    ) => cooperativeWedge(call, signal);
    exec.setConcurrencyClassFor("timed", SHARED_READ);
    exec.addTool(makeBlock("t1", "timed"), makeCall("t1", "timed"));
    exec.dispatchPending();
    exec.close();

    const results: ToolDispatchResult[] = [];
    const outcome = await withTimeout(
      (async () => {
        for await (const r of exec.getRemainingResults()) {
          results.push(r.result);
        }
      })(),
      4000,
      "cause-pinned",
    );
    expect(outcome.ok).toBe(true);
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.isError).toBe(true);
    const decoded = JSON.parse(result.content) as { content: string };
    // buildTerminalToolResult({ cause: "timeout" }) -> "tool execution timed out".
    expect(decoded.content).toContain("tool execution timed out");
    expect(decoded.content).not.toContain("aborted before completion");
  });
});

// ──────────────────────────────────────────────────────────────────────
// §4.2 — Live-path integration: a wedged PRE-HOOK (router.ts:763 seam,
// run INSIDE the ToolCallRuntime lock by router.dispatchModelToolCall)
// flips `leaked` → `reclaimed`.
//
// The earlier suites drive the `runToolUseFn` shortcut, which BYPASSES the
// router pre-hook block. To exercise the real live seam we wire a genuine
// `liveToolDispatch` (routerFromRegistry + preHooks). A small maxToolDrainMs
// makes drainCancel fire quickly; the drain signal flows
// opts.signal → router.ts:763 runPreToolUseHooks → raceHookWithSignal,
// which cancels the wedged hook in place ⇒ synthetic fail-closed deny ⇒
// the lock-wrapped dispatch settles ⇒ the ToolCallRuntime write-lock frees
// ⇒ a sibling EXCLUSIVE acquire resolves.
// ──────────────────────────────────────────────────────────────────────
describe("StreamingToolExecutor live-path wedged pre-hook (reclaimed not leaked)", () => {
  function liveTool(name: string): Tool {
    return testTool({
      name,
      concurrencyClass: EXCLUSIVE,
      // The TOOL itself completes instantly — the wedge is the PRE-HOOK,
      // which never reaches execute (deny short-circuits).
      execute: async () => ({ content: "tool ran" }),
    });
  }

  // A cooperative wedged pre-hook: resolves a deny when its signal aborts
  // (proves the threaded signal REACHES the hook). Uncooperative variant:
  // ignores the signal entirely (proves the RACE releases the lock anyway).
  const cooperativePreHook: PreToolUseHook = ({ signal }) =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve({ kind: "deny", reason: "cancelled" });
        return;
      }
      signal?.addEventListener(
        "abort",
        () => resolve({ kind: "deny", reason: "cancelled" }),
        { once: true },
      );
    });
  const uncooperativePreHook: PreToolUseHook = () =>
    new Promise<never>(() => {});

  for (const variant of [
    { name: "cooperative", hook: cooperativePreHook, expectOrphan: false },
    { name: "uncooperative", hook: uncooperativePreHook, expectOrphan: true },
  ] as const) {
    test(`${variant.name} wedged pre-hook: turn finalizes reclaimed, no leak, sibling EXCLUSIVE acquires`, async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      const eventLog = new EventLog();
      const orphanedEvents: string[] = [];
      const cancelledEvents: string[] = [];
      const unsub = eventLog.subscribe((ev) => {
        const msg = ev.msg as { type?: string; payload?: { cause?: string } };
        if (msg.type === "warning" && msg.payload?.cause === "hook_orphaned") {
          orphanedEvents.push(ev.id);
        }
        if (msg.type === "warning" && msg.payload?.cause === "hook_cancelled") {
          cancelledEvents.push(ev.id);
        }
      });

      // The ROUTER registry carries the tool so dispatchModelToolCall's
      // findSpec resolves and the live preHooks block at router.ts:763
      // actually runs. The EXECUTOR registry is intentionally EMPTY so the
      // drain deadline falls back to the flat `maxToolDrainMs` floor
      // (toolDrainDeadlineMs's def===undefined branch) rather than
      // own-timeout + 60s grace — this is what makes the per-tool drainCancel
      // / reclaim-accounting path fire in-test. A pre-hook wedge never reaches
      // tool.execute, so the tool's own execute timeout is irrelevant here.
      const routerRegistry = registryFor(
        async () => ({ content: "registry dispatch should not run", isError: true }),
        [liveTool("wedgehook")],
      );
      const executorRegistry = registryFor(
        async () => ({ content: "registry dispatch should not run", isError: true }),
        [],
      );
      const runtime = new ToolCallRuntime();
      const exec = new StreamingToolExecutor({
        registry: executorRegistry,
        runtime,
        maxToolDrainMs: 200,
        cleanupGraceMs: 150,
        liveToolDispatch: {
          router: routerFromRegistry(routerRegistry),
          options: {
            session: { eventLog, services: {} } as never,
            turn: { subId: "turn-wedge" } as never,
            tracker: {
              appendFileDiff: () => {},
              snapshot: () => [],
              clear: () => {},
            },
            approvalPolicy: "never",
            sandboxMode: "workspace_write",
            preHooks: [variant.hook],
          },
        },
      });

      exec.setConcurrencyClassFor("wedgehook", EXCLUSIVE);
      exec.addTool(makeBlock("w1", "wedgehook"), makeCall("w1", "wedgehook"));
      exec.dispatchPending();
      exec.close();

      const collected: Array<{ id: string; isError: boolean }> = [];
      const outcome = await withTimeout(
        (async () => {
          for await (const r of exec.getRemainingResults()) {
            collected.push({
              id: r.toolCall.id,
              isError: r.result.isError === true,
            });
          }
        })(),
        4000,
        `live-wedge-${variant.name}`,
      );

      // (a) the turn finalizes with exactly one isError result (the
      //     fail-closed deny renders a paired <tool_use_error>).
      expect(outcome.ok).toBe(true);
      expect(collected).toEqual([{ id: "w1", isError: true }]);

      // Allow the reclaim grace race to classify.
      await new Promise((r) => setTimeout(r, 250).unref?.());

      const tracked = (
        exec as unknown as { tools: Array<{ id: string; outcome?: string }> }
      ).tools.find((t) => t.id === "w1");
      // (b) outcome reclaimed and leakedToolCount did NOT increment.
      expect(tracked?.outcome).toBe("reclaimed");
      expect(exec.leakedTools).toBe(0);

      // a hook_cancelled attachment fired on every cancellation.
      expect(cancelledEvents.length).toBeGreaterThanOrEqual(1);

      // (d) uncooperative variant: a hook_orphaned event fired exactly once.
      if (variant.expectOrphan) {
        expect(orphanedEvents).toHaveLength(1);
      } else {
        expect(orphanedEvents).toHaveLength(0);
      }

      // (c) a follow-up EXCLUSIVE acquire on the SAME runtime resolves
      //     (the wedged-pre-hook holder released the write-lock).
      const acquire = await withTimeout(
        runtime.run(EXCLUSIVE, async () => "ok"),
        1000,
        "live-sibling-exclusive-acquire",
      );
      expect(acquire.ok).toBe(true);
      if (acquire.ok) expect(acquire.value).toBe("ok");

      // no unhandledRejection from the orphaned/detached hook promise.
      await new Promise((r) => setTimeout(r, 50).unref?.());
      unsub();
      process.off("unhandledRejection", onUnhandled);
      expect(unhandled).toEqual([]);
    });
  }

  // §4.4 non-regression: the synthetic pre-hook cancel-deny renders a
  // <tool_use_error> tool_result and is NOT misclassified as an interrupt
  // (the router deny path returns <tool_use_error> directly, never
  // INTERRUPT_MESSAGE_FOR_TOOL_USE). Exercised on the DIRECT router path
  // with an already-aborted signal so the deny actually renders (the drain
  // backstop does not race/override it here).
  test("synthetic pre-hook cancel-deny renders <tool_use_error>, not an interrupt", async () => {
    const eventLog = new EventLog();
    const registry = registryFor(
      async () => ({ content: "registry dispatch should not run", isError: true }),
      [liveTool("wedgehook")],
    );
    const router = routerFromRegistry(registry);
    const ac = new AbortController();
    ac.abort("tool timeout: drain exceeded");

    const result = await (
      router as unknown as {
        dispatchModelToolCall(
          call: LLMToolCall,
          opts: Record<string, unknown>,
        ): Promise<ToolDispatchResult>;
      }
    ).dispatchModelToolCall(makeCall("w1", "wedgehook"), {
      session: { eventLog, services: {} },
      turn: { subId: "turn-deny" },
      tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
      approvalPolicy: "never",
      sandboxMode: "workspace_write",
      preHooks: [uncooperativePreHook],
      signal: ac.signal,
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("<tool_use_error>");
    expect(String(result.content)).toContain("pre-hook cancelled");
    // NOT misclassified as a user interrupt.
    expect(String(result.content)).not.toContain(
      "[Request interrupted by user for tool use]",
    );
  });
});
