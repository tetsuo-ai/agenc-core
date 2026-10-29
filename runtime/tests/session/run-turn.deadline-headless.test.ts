import { afterEach, beforeEach, expect, test } from "vitest";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import { oneShotFastModeActive, oneShotFastModeSelected } from "../../src/one-shot-fast-mode.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { runTurn } from "../../src/session/run-turn.js";
import { setRunDeadlineClockForTests } from "../../src/session/run-deadline.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { createFakeRunDeadlineClock } from "../helpers/fake-run-deadline-clock.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

let clock: ReturnType<typeof createFakeRunDeadlineClock>;
beforeEach(() => {
  clock = createFakeRunDeadlineClock();
  setRunDeadlineClockForTests(clock);
});
afterEach(() => setRunDeadlineClockForTests(null));

function exercise(withDeadline = true, providerDelayMs = 0) {
  const requests: LLMMessage[][] = [];
  const fastCalls: boolean[] = [];
  const provider = mkProvider();
  provider.chatStream = async (messages, _delta, options): Promise<LLMResponse> => {
    requests.push(structuredClone(messages));
    fastCalls.push(oneShotFastModeActive());
    clock.advance(providerDelayMs);
    options?.signal?.throwIfAborted();
    const tool = requests.length <= 4;
    return { content: tool ? "" : "Saved and checked.",
      toolCalls: tool ? [{ id: `probe-${requests.length}`, name: "probe", arguments: "{}" }] : [],
      finishReason: tool ? "tool_calls" : "stop", model: "test-model",
      usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } };
  };
  const execute = async () => { clock.advance(20_000); return { content: "checked" }; };
  const runtimeOptions = resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true,
    dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true,
    ...(withDeadline ? { deadlineAt: clock.now() + 120_000, deadlineReserveMs: 60_000 } : {}),
  });
  const { session, state, events } = mkSession({ provider, registry: {
    tools: [{ name: "probe", description: "Check a candidate", inputSchema: { type: "object" }, execute }],
    toLLMTools: () => [], dispatch: execute,
  } as never, services: { runtimeOptions } });
  Object.assign(session.services, { permissionModeRegistry: new PermissionModeRegistry({
    ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
  }) });
  const ctx = mkCtx({ permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" } });
  return { session, ctx, state, events, requests, fastCalls, runtimeOptions };
}

test("a budgeted Light headless run gets time, preservation and reserve guidance before working", async () => {
  const f = exercise();
  await drain(runTurn(f.session, f.ctx, "Write a small valid result, then improve it.", { exactOutput: true }));
  expect(f.requests).toHaveLength(5);
  expect(f.fastCalls).toEqual([false, false, false, false, false]);
  const first = JSON.stringify(f.requests[0]);
  expect(first).toContain("This run has a fixed time budget");
  expect(first).toContain("minimal valid deliverable at the requested path early");
  expect(first).toContain("atomic rename");
  expect(first).toContain("empty placeholder");
  expect(JSON.stringify(f.requests[1])).toContain("[time_remaining_sec=100]");
  const reserve = JSON.stringify(f.requests[3]);
  expect(reserve).toContain("Time is nearly up: 60 s remain");
  expect(reserve).toContain("Stop exploring");
  expect(reserve).toContain("requested path");
  const history = JSON.stringify(f.state.history);
  expect(history).not.toContain("time_remaining_sec");
  expect(history).not.toContain("This run has a fixed time budget");
  expect(f.events.filter(e => e.msg.type === "warning" && e.msg.payload.cause === "deadline_reserve")).toHaveLength(1);
});

test("the deadline interrupts the first provider call in a headless bypass run", async () => {
  const f = exercise(true, 130_000);
  const phases = [];
  for await (const phase of runTurn(f.session, f.ctx, "Write the result.", { exactOutput: true })) phases.push(phase);
  expect(f.requests).toHaveLength(1);
  expect(phases.at(-1)).toMatchObject({ stopReason: "deadline_reached" });
  expect(f.events.some(e => e.msg.type === "turn_aborted")).toBe(false);
  expect(clock.pending()).toBe(0);
});

test("unbudgeted headless runs retain the optimized loop with no deadline overhead", async () => {
  const f = exercise(false);
  expect(oneShotFastModeSelected(f.runtimeOptions, {})).toBe(true);
  await drain(runTurn(f.session, f.ctx, "Write a small valid result.", { exactOutput: true }));
  expect(f.fastCalls.slice(0, 4)).toEqual([true, true, true, true]);
  expect(JSON.stringify(f.requests)).not.toContain("time_remaining_sec");
  expect(JSON.stringify(f.requests)).not.toContain("This run has a fixed time budget");
  expect(clock.pending()).toBe(0);
});
