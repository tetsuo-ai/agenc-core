import { describe, expect, test } from "vitest";
import { StreamingToolExecutor } from "./streaming-executor.js";
import { SHARED_READ } from "./concurrency.js";
import type { ToolRegistry, ToolDispatchResult } from "../tool-registry.js";
import type { LLMTool, LLMToolCall } from "../llm/types.js";
import type { Tool } from "./types.js";
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
