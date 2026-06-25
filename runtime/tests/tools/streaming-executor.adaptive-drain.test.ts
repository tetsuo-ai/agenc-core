import { afterEach, describe, expect, test, vi } from "vitest";
import { StreamingToolExecutor } from "./streaming-executor.js";
import { SHARED_READ } from "./concurrency.js";
import { ToolLatencyStore } from "./tool-latency-store.js";
import type { ToolRegistry, ToolDispatchResult } from "../tool-registry.js";
import type { LLMTool, LLMToolCall } from "../llm/types.js";
import type { Tool } from "./types.js";
import type { ToolUseBlock } from "../session/turn-state.js";

const GRACE_MS = 60_000;
const FLAT_FLOOR_MS = 180_000;

// ── shared helpers (mirrors streaming-executor.stuck-tool-drain.test.ts) ──
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
      setTimeout(
        () => resolve({ ok: false, reason: `TIMEOUT(${label})` }),
        ms,
      ).unref?.(),
    ),
  ]);
}

// A minimal `liveToolDispatch` whose ONLY load-bearing reach for these tests is
// `options.session.services.toolLatencyStore`. The deadline path never consults
// the router for a tool that lives in the executor registry (resolveModelToolName
// returns the name unchanged), so a no-op router suffices.
function liveDispatchWithStore(store: ToolLatencyStore | undefined): {
  router: never;
  options: never;
} {
  return {
    router: {
      findSpec: () => undefined,
      dispatchModelToolCall: async () => ({ content: "", isError: false }),
      toolSupportsParallel: () => true,
    } as unknown as never,
    options: {
      session: { services: { toolLatencyStore: store } },
      turn: { subId: "adaptive-test" },
      tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
      approvalPolicy: "never",
      sandboxMode: "workspace_write",
    } as unknown as never,
  };
}

// White-box deadline accessor.
interface InternalExec {
  tools: Array<{ toolCall: LLMToolCall; executingSinceMs?: number }>;
  toolDrainDeadlineMs(tool: {
    toolCall: LLMToolCall;
    executingSinceMs?: number;
  }): number;
}
function internal(exec: StreamingToolExecutor): InternalExec {
  return exec as unknown as InternalExec;
}

// Build an executor wired with an (optionally seeded) latency store, a single
// finite-own tool in the executor registry, and the adaptive flag toggled.
// Returns the executor plus the tracked tool for white-box deadline queries.
function buildDeadlineExec(opts: {
  store: ToolLatencyStore | undefined;
  enabled: boolean;
  toolName?: string;
  ownTimeoutMs?: number;
  maxToolDrainMs?: number;
  safeMinMs?: number;
  marginMult?: number;
  raiseCap?: number;
  args?: string;
}): { exec: StreamingToolExecutor; tool: InternalExec["tools"][number] } {
  const name = opts.toolName ?? "Read";
  const tool = testTool({
    name,
    ...(opts.ownTimeoutMs !== undefined
      ? { timeoutMs: opts.ownTimeoutMs }
      : {}),
  });
  const exec = new StreamingToolExecutor({
    registry: registryFor(
      () => new Promise<ToolDispatchResult>(() => {}),
      [tool],
    ),
    maxToolDrainMs: opts.maxToolDrainMs ?? FLAT_FLOOR_MS,
    adaptiveDrainEnabled: opts.enabled,
    ...(opts.safeMinMs !== undefined
      ? { adaptiveDrainSafeMinMs: opts.safeMinMs }
      : {}),
    ...(opts.marginMult !== undefined
      ? { adaptiveDrainMarginMult: opts.marginMult }
      : {}),
    ...(opts.raiseCap !== undefined
      ? { adaptiveDrainRaiseCap: opts.raiseCap }
      : {}),
    liveToolDispatch: liveDispatchWithStore(opts.store),
  });
  exec.setConcurrencyClassFor(name, SHARED_READ);
  exec.addTool(makeBlock("t1", name), makeCall("t1", name, opts.args ?? "{}"));
  exec.dispatchPending();
  const tracked = internal(exec).tools.find((t) => t.toolCall.id === "t1")!;
  return { exec, tool: tracked };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("StreamingToolExecutor adaptive drain (Goal #4a) — deadline math", () => {
  // (#8) FAST tool → TIGHTER deadline. 200 fast (~50ms) samples, own=30s, flat
  // = max(180s, 90s) = 180s. Adaptive: candidate = 1.5*50ms + 60s ≈ 60s, clamp
  // lo = max(own+grace=90s, safeMin=30s) = 90s → deadline 90s, strictly <180s.
  // REVERT: with toolDrainDeadlineMs's final return reverted to the flat
  // formula, the deadline is 180s and `< 180_000` reddens.
  test("#8 fast tool gets a TIGHTER deadline (90s < flat 180s)", () => {
    const store = new ToolLatencyStore();
    for (let i = 0; i < 200; i += 1) store.record("Read", 50);
    const { exec, tool } = buildDeadlineExec({
      store,
      enabled: true,
      toolName: "Read",
      ownTimeoutMs: 30_000,
    });
    const deadline = internal(exec).toolDrainDeadlineMs(tool);
    expect(deadline).toBe(90_000); // own(30s) + grace(60s) floor
    expect(deadline).toBeLessThan(FLAT_FLOOR_MS);
    exec.discard("teardown");
  });

  // (#9 white-box) SLOW-but-legit → deadline RAISED above 180s. p99 ≈ 150s,
  // own=30s → candidate = 1.5*150s + 60s = 285s > 180s. A 200s legit run that
  // flat-180s would FALSE-KILL now survives (deadline 285s).
  // REVERT: flat formula → deadline 180s, `> 180_000` reddens.
  test("#9 slow-but-legit tool RAISES the deadline above flat (≈285s > 180s)", () => {
    const store = new ToolLatencyStore();
    // 200 samples whose p99 ≈ 150s (mostly fast, tail at 150s so p99 lands there).
    for (let i = 0; i < 198; i += 1) store.record("slow", 10_000);
    for (let i = 0; i < 2; i += 1) store.record("slow", 150_000);
    const { exec, tool } = buildDeadlineExec({
      store,
      enabled: true,
      toolName: "slow",
      ownTimeoutMs: 30_000,
    });
    const deadline = internal(exec).toolDrainDeadlineMs(tool);
    expect(deadline).toBeGreaterThan(FLAT_FLOOR_MS); // RAISED, not killed at 180s
    // ≈ 1.5*150s + 60s = 285s (allow margin since p99 of the ring picks 150s).
    expect(deadline).toBeGreaterThanOrEqual(285_000 - 1);
    expect(deadline).toBeLessThan(285_000 * 2);
    // And a 200s legit run sits comfortably under the deadline.
    expect(200_000).toBeLessThan(deadline);
    exec.discard("teardown");
  });

  // (#10) COLD-START == DISABLED differential. enabled-but-empty store must be
  // byte-identical to AGENC_ADAPTIVE_DRAIN=0 for fast/slow/default tools.
  test("#10 cold-start (enabled, empty store) == disabled, byte-identical", () => {
    for (const own of [undefined, 30_000, 600_000]) {
      const emptyStore = new ToolLatencyStore();
      const enabled = buildDeadlineExec({
        store: emptyStore,
        enabled: true,
        toolName: "X",
        ...(own !== undefined ? { ownTimeoutMs: own } : {}),
      });
      const disabled = buildDeadlineExec({
        store: new ToolLatencyStore(),
        enabled: false,
        toolName: "X",
        ...(own !== undefined ? { ownTimeoutMs: own } : {}),
      });
      const dEnabled = internal(enabled.exec).toolDrainDeadlineMs(enabled.tool);
      const dDisabled = internal(disabled.exec).toolDrainDeadlineMs(
        disabled.tool,
      );
      expect(dEnabled).toBe(dDisabled);
      enabled.exec.discard("teardown");
      disabled.exec.discard("teardown");
    }
  });

  // (#13) timeoutBehavior:"tool" stays Infinity — the store is NEVER consulted,
  // even fully populated under that resolved name. Guards against moving the
  // store call above the `own === null` exemption branch.
  test("#13 timeoutBehavior:'tool' stays Infinity (store never consulted)", () => {
    const store = new ToolLatencyStore();
    for (let i = 0; i < 300; i += 1) store.record("request-user-input", 50);
    const exemptTool = testTool({
      name: "request-user-input",
      timeoutBehavior: "tool",
    });
    const exec = new StreamingToolExecutor({
      registry: registryFor(
        () => new Promise<ToolDispatchResult>(() => {}),
        [exemptTool],
      ),
      maxToolDrainMs: FLAT_FLOOR_MS,
      adaptiveDrainEnabled: true,
      liveToolDispatch: liveDispatchWithStore(store),
    });
    exec.setConcurrencyClassFor("request-user-input", SHARED_READ);
    exec.addTool(
      makeBlock("e1", "request-user-input"),
      makeCall("e1", "request-user-input"),
    );
    exec.dispatchPending();
    const tool = internal(exec).tools.find((t) => t.toolCall.id === "e1")!;
    expect(internal(exec).toolDrainDeadlineMs(tool)).toBe(
      Number.POSITIVE_INFINITY,
    );
    exec.discard("teardown");
  });

  // (#15) Crash-safe reach: enabled but NO liveToolDispatch ⇒ the deadline is
  // the flat formula and the construction does not throw.
  // REVERT (against a non-optional `this.liveToolDispatch.options...`): throws.
  test("#15 crash-safe: enabled + no liveToolDispatch → flat formula, no throw", () => {
    const tool = testTool({ name: "Read", timeoutMs: 30_000 });
    const exec = new StreamingToolExecutor({
      registry: registryFor(
        () => new Promise<ToolDispatchResult>(() => {}),
        [tool],
      ),
      maxToolDrainMs: FLAT_FLOOR_MS,
      adaptiveDrainEnabled: true,
      // NO liveToolDispatch — minimal/test executor shape.
    });
    exec.setConcurrencyClassFor("Read", SHARED_READ);
    exec.addTool(makeBlock("r1", "Read"), makeCall("r1", "Read"));
    exec.dispatchPending();
    const tracked = internal(exec).tools.find((t) => t.toolCall.id === "r1")!;
    let deadline = 0;
    expect(() => {
      deadline = internal(exec).toolDrainDeadlineMs(tracked);
    }).not.toThrow();
    expect(deadline).toBe(Math.max(FLAT_FLOOR_MS, 30_000 + GRACE_MS)); // flat
    exec.discard("teardown");
  });

  // (#16) SAFE-MIN floor property: for randomized sample sets and random own,
  // deadline ≥ max(own + grace, safeMin) ALWAYS. This is the false-kill guard.
  // REVERT: removing the `lo` clamp lets a tiny estimate drop below the floor.
  test("#16 floor property: deadline ≥ max(own+grace, safeMin) for random inputs", () => {
    const safeMin = 45_000;
    for (let trial = 0; trial < 60; trial += 1) {
      const own = 1_000 + Math.floor(Math.random() * 600_000);
      const store = new ToolLatencyStore({ minSamples: 50 });
      // Random sample distribution (any latencies, incl. tiny → would tighten).
      const n = 50 + Math.floor(Math.random() * 100);
      for (let i = 0; i < n; i += 1) {
        store.record("Rnd", Math.random() * 500); // sub-second fast samples
      }
      const { exec, tool } = buildDeadlineExec({
        store,
        enabled: true,
        toolName: "Rnd",
        ownTimeoutMs: own,
        safeMinMs: safeMin,
      });
      const deadline = internal(exec).toolDrainDeadlineMs(tool);
      const floor = Math.max(own + GRACE_MS, safeMin);
      expect(deadline).toBeGreaterThanOrEqual(floor);
      exec.discard("teardown");
    }
  });

  // (#17) Raise-cap clamps a garbage outlier. One 1e9 ms sample → the candidate
  // explodes, but `hi = max(maxDrain, own+grace)*raiseCap` clamps it.
  test("#17 raise-cap clamps a garbage 1e9ms outlier to hi", () => {
    const store = new ToolLatencyStore({ minSamples: 1 });
    store.record("Garbage", 1_000_000_000); // 1e9 ms
    const { exec, tool } = buildDeadlineExec({
      store,
      enabled: true,
      toolName: "Garbage",
      ownTimeoutMs: 30_000,
      maxToolDrainMs: FLAT_FLOOR_MS,
      raiseCap: 4,
    });
    const deadline = internal(exec).toolDrainDeadlineMs(tool);
    const ownFloor = 30_000 + GRACE_MS;
    const hi = Math.max(FLAT_FLOOR_MS, ownFloor) * 4;
    expect(deadline).toBe(hi); // clamped to the runaway ceiling, NOT unbounded
    expect(Number.isFinite(deadline)).toBe(true);
    exec.discard("teardown");
  });
});

// ── runtime-behavior tests ──
//
// `DRAIN_GRACE_MS` (60s) floors EVERY adaptive def-path deadline at ≥60s, so a
// real-timer wedge cannot be force-finalized inside a 30s test budget on the
// adaptive path. We instead drive the watchdog white-box: back-date
// `executingSinceMs` so `now - since` straddles the flat vs adaptive deadline,
// then invoke `forceTimeoutOverdueExecutingTools()` directly. This proves the
// force fires (or does NOT) as a function of the deadline NUMBER — exactly what
// the adaptive change controls — and is revert-sensitive at sub-second speed.
interface ForceInternal extends InternalExec {
  forceTimeoutOverdueExecutingTools(): boolean;
  resolveModelToolName(name: string): string;
}
function forceInternal(exec: StreamingToolExecutor): ForceInternal {
  return exec as unknown as ForceInternal;
}

// Back-date a tool's `executingSinceMs` so the watchdog sees `elapsedMs`
// elapsed; leave it `executing` so the force path considers it.
function backdateExecuting(
  exec: StreamingToolExecutor,
  id: string,
  elapsedMs: number,
): void {
  const t = (
    exec as unknown as {
      tools: Array<{
        toolCall: LLMToolCall;
        status: string;
        executingSinceMs?: number;
      }>;
    }
  ).tools.find((x) => x.toolCall.id === id)!;
  t.status = "executing";
  t.executingSinceMs = performance.now() - elapsedMs;
}

describe("StreamingToolExecutor adaptive drain (Goal #4a) — runtime behavior", () => {
  function drainCollect(exec: StreamingToolExecutor): {
    done: Promise<void>;
    collected: Array<{ id: string; isError: boolean }>;
  } {
    const collected: Array<{ id: string; isError: boolean }> = [];
    const done = (async () => {
      for await (const r of exec.getRemainingResults()) {
        collected.push({
          id: r.toolCall.id,
          isError: r.result.isError === true,
        });
      }
    })();
    return { done, collected };
  }

  // (#9 runtime) A LEGIT slow run, having executed PAST the flat 180s deadline
  // but UNDER the raised adaptive deadline (≈285s), is NOT force-finalized.
  // We back-date executingSinceMs to 200s (200_000ms) — strictly above the flat
  // 180s, where the flat rule WOULD force-kill it — and assert the watchdog
  // does NOT force it (adaptive deadline 285s not yet crossed). Then a clean
  // settle records the real 200s sample.
  // REVERT (flat formula → deadline 180s): at 200s elapsed the watchdog DOES
  // force-finalize → `forced === false` reddens (the run is killed). Reported.
  test("#9 slow-but-legit run past the flat floor is NOT force-killed (adaptive raised)", async () => {
    const store = new ToolLatencyStore();
    // p99 ≈ 150s → adaptive deadline ≈ 1.5*150s + 60s = 285s (> flat 180s).
    for (let i = 0; i < 198; i += 1) store.record("legit", 10_000);
    for (let i = 0; i < 2; i += 1) store.record("legit", 150_000);

    let releaseDispatch!: (r: ToolDispatchResult) => void;
    const gate = new Promise<ToolDispatchResult>((resolve) => {
      releaseDispatch = resolve;
    });
    const legitTool = testTool({ name: "legit", timeoutMs: 30_000 }); // own=30s
    const exec = new StreamingToolExecutor({
      registry: registryFor(() => gate, [legitTool]),
      maxToolDrainMs: FLAT_FLOOR_MS, // flat = max(180s, 30s+60s) = 180s
      adaptiveDrainEnabled: true,
      liveToolDispatch: liveDispatchWithStore(store),
    });
    (exec as unknown as { runToolUseFn?: unknown }).runToolUseFn = (
      call: LLMToolCall,
    ) => (exec as { registry: ToolRegistry }).registry.dispatch(call);
    exec.setConcurrencyClassFor("legit", SHARED_READ);
    exec.addTool(makeBlock("L1", "legit"), makeCall("L1", "legit"));
    exec.dispatchPending();
    exec.close();

    const tracked = internal(exec).tools.find((t) => t.toolCall.id === "L1")!;
    const deadline = internal(exec).toolDrainDeadlineMs(tracked);
    expect(deadline).toBeGreaterThan(FLAT_FLOOR_MS); // RAISED above 180s

    const { done, collected } = drainCollect(exec);

    // Simulate 200s of execution — PAST the flat 180s, UNDER the adaptive 285s.
    backdateExecuting(exec, "L1", 200_000);
    const forced = forceInternal(exec).forceTimeoutOverdueExecutingTools();
    // THE CRITICAL GUARD: the legit run is NOT force-finalized. (Flat formula:
    // 200s > 180s → forced true → revert reddens.)
    expect(forced).toBe(false);

    // Now the dispatch settles cleanly → real result, clean sample recorded.
    releaseDispatch({ content: "legit done", isError: false });
    const final = await withTimeout(done, 4000, "legit-settles");
    expect(final.ok).toBe(true);
    expect(collected).toEqual([{ id: "L1", isError: false }]); // REAL, not synthetic
    expect(exec.leakedTools).toBe(0);
    const stat = (
      store as unknown as { perTool: Map<string, { total: number }> }
    ).perTool.get("legit");
    expect(stat!.total).toBe(201); // 200 seeded + 1 clean settle recorded
  });

  // (#9 differential) Under the FLAT rule (adaptive disabled), the SAME 200s
  // elapsed DOES force-finalize — proving the adaptive raise is what saved the
  // run above. (This is the in-suite analog of the manual revert.)
  test("#9 differential: with adaptive OFF the same 200s run IS force-killed at 180s", async () => {
    const legitTool = testTool({ name: "legit", timeoutMs: 30_000 });
    const exec = new StreamingToolExecutor({
      registry: registryFor(
        () => new Promise<ToolDispatchResult>(() => {}),
        [legitTool],
      ),
      maxToolDrainMs: FLAT_FLOOR_MS,
      adaptiveDrainEnabled: false, // FLAT
      liveToolDispatch: liveDispatchWithStore(new ToolLatencyStore()),
    });
    (exec as unknown as { runToolUseFn?: unknown }).runToolUseFn = () =>
      new Promise<ToolDispatchResult>(() => {});
    exec.setConcurrencyClassFor("legit", SHARED_READ);
    exec.addTool(makeBlock("L1", "legit"), makeCall("L1", "legit"));
    exec.dispatchPending();
    exec.close();

    const tracked = internal(exec).tools.find((t) => t.toolCall.id === "L1")!;
    expect(internal(exec).toolDrainDeadlineMs(tracked)).toBe(FLAT_FLOOR_MS);

    backdateExecuting(exec, "L1", 200_000);
    const forced = forceInternal(exec).forceTimeoutOverdueExecutingTools();
    expect(forced).toBe(true); // 200s > flat 180s → KILLED

    exec.discard("teardown");
  });

  // (#11) Anti-ratchet: a FORCE-FINALIZED tool is NOT recorded. Spy on the
  // store's `record`. We force-finalize a wedged tool white-box, then resolve
  // its dispatch so the runOne tail runs; the error/outcome gate must exclude
  // it. A killed-duration sample feeding back would ratchet the deadline up.
  // REVERT (remove the error/outcome gate): the runOne tail records the
  // force-finalized run → record() called for the wedged tool → spy reddens.
  test("#11 anti-ratchet: a force-finalized tool is NOT recorded", async () => {
    const store = new ToolLatencyStore({ minSamples: 5 });
    const recordSpy = vi.spyOn(store, "record");

    const wedgeTool = testTool({ name: "wedge", timeoutMs: 30_000 });
    const exec = new StreamingToolExecutor({
      registry: registryFor(
        () => new Promise<ToolDispatchResult>(() => {}),
        [wedgeTool],
      ),
      maxToolDrainMs: FLAT_FLOOR_MS,
      cleanupGraceMs: 100,
      adaptiveDrainEnabled: true,
      liveToolDispatch: liveDispatchWithStore(store),
    });
    // Cooperative wedge: rejects when its drainCancel signal aborts so its
    // runOne `catch` runs (error set) and the tail record gate excludes it.
    let releaseReject!: () => void;
    (exec as unknown as { runToolUseFn?: unknown }).runToolUseFn = (
      _call: LLMToolCall,
      signal: AbortSignal,
    ) =>
      new Promise<ToolDispatchResult>((_resolve, reject) => {
        releaseReject = () => reject(new Error("aborted"));
        if (signal.aborted) {
          releaseReject();
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    exec.setConcurrencyClassFor("wedge", SHARED_READ);
    exec.addTool(makeBlock("W1", "wedge"), makeCall("W1", "wedge"));
    exec.dispatchPending();
    exec.close();

    const { done, collected } = drainCollect(exec);

    // Simulate the deadline being crossed and force-finalize white-box.
    backdateExecuting(exec, "W1", FLAT_FLOOR_MS + 1_000);
    const forced = forceInternal(exec).forceTimeoutOverdueExecutingTools();
    expect(forced).toBe(true); // wedge IS force-finalized

    const outcome = await withTimeout(done, 4000, "wedge-forced");
    expect(outcome.ok).toBe(true);
    expect(collected).toEqual([{ id: "W1", isError: true }]); // synthetic timeout

    // Flush the runOne tail / reclaim race (drainCancel already fired).
    await new Promise((r) => setTimeout(r, 250).unref?.());

    // THE LOAD-BEARING ASSERTION: record() was NEVER called for the wedged run.
    expect(recordSpy).not.toHaveBeenCalled();
    const stat = (
      store as unknown as { perTool: Map<string, { total: number }> }
    ).perTool.get("wedge");
    expect(stat).toBeUndefined(); // no killed-duration sample leaked in

    recordSpy.mockRestore();
  });

  // (#11 cont.) A subsequent CLEAN run on a fresh tool name DOES record — so the
  // recording path is alive; only KILLED runs are excluded (not all runs).
  test("#11 anti-ratchet: a clean run IS recorded (the gate excludes only kills)", async () => {
    const store = new ToolLatencyStore({ minSamples: 1 });
    let release!: (r: ToolDispatchResult) => void;
    const gate = new Promise<ToolDispatchResult>((resolve) => {
      release = resolve;
    });
    const cleanTool = testTool({ name: "clean", timeoutMs: 30_000 });
    const exec = new StreamingToolExecutor({
      registry: registryFor(() => gate, [cleanTool]),
      maxToolDrainMs: FLAT_FLOOR_MS, // big floor so the clean run is never forced
      adaptiveDrainEnabled: true,
      liveToolDispatch: liveDispatchWithStore(store),
    });
    (exec as unknown as { runToolUseFn?: unknown }).runToolUseFn = (
      call: LLMToolCall,
    ) => (exec as { registry: ToolRegistry }).registry.dispatch(call);
    exec.setConcurrencyClassFor("clean", SHARED_READ);
    exec.addTool(makeBlock("C1", "clean"), makeCall("C1", "clean"));
    exec.dispatchPending();
    exec.close();

    const { done, collected } = drainCollect(exec);
    release({ content: "clean ok", isError: false }); // settle cleanly at once
    const outcome = await withTimeout(done, 4000, "clean-settles");
    expect(outcome.ok).toBe(true);
    expect(collected).toEqual([{ id: "C1", isError: false }]);

    const stat = (
      store as unknown as { perTool: Map<string, { total: number }> }
    ).perTool.get("clean");
    expect(stat).toBeDefined();
    expect(stat!.total).toBe(1); // the clean run WAS recorded
  });
});
