import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { LLMStreamTruncatedError } from "../../src/llm/errors.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
} from "../../src/llm/types.js";
import { oneShotFastModeActive } from "../../src/one-shot-fast-mode.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import * as recovery from "../../src/recovery/fallback-ladder.js";
import { setRunDeadlineClockForTests } from "../../src/session/run-deadline.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { taskBudgetOf } from "../../src/session/task-budget.js";
import { createTestConfigStore, mkCtx, mkSession } from "../fixtures.js";
import { createFakeRunDeadlineClock } from "../helpers/fake-run-deadline-clock.js";

afterEach(() => {
  vi.restoreAllMocks();
  setRunDeadlineClockForTests(null);
});

const CONTEXT_WINDOW_TOKENS = 64_000;
const MAX_OUTPUT_TOKENS = 256;
const PARTIAL = "The files in /app are";

/**
 * TB2.1 trials sparql-university__MQCrXz2 and torch-pipeline-parallelism__U8J3FFE:
 * the recorder's upstream DeepSeek connection was reset while a one-shot fast
 * loop reply was streaming. Part of the reply arrived, then the stream ended
 * with a socket error or without a finish_reason. The fast loop handed the turn
 * to the standard loop, whose resample reused the failed attempt's admission
 * identity; admission refused that terminal row and the run exited 1 with
 * `execution admission deny: provider_call_failed_after_dispatch`.
 */
const resets: Record<string, () => Error> = {
  connection_reset: () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  stream_truncated: () => new LLMStreamTruncatedError("grok", "SSE stream closed before any finish_reason"),
};

interface ResetRun {
  readonly calls: number;
  readonly fastCalls: number;
  readonly requests: readonly LLMMessage[][];
  readonly events: ReadonlyArray<{ readonly msg: { readonly type: string; readonly payload?: unknown } }>;
  readonly phases: readonly PhaseEvent[];
  readonly terminal: { readonly reason: string; readonly error?: unknown } | undefined;
  readonly thrown: unknown;
  readonly journal: ReadonlyArray<{ readonly event: string; readonly stepId: string; readonly reason?: string }>;
  readonly summary: { readonly hasUnknownCost: boolean; readonly heldCostUsd: number; readonly modelCalls: number } | undefined;
  readonly budget: { readonly tokens: number; readonly calls: number } | undefined;
  readonly execute: ReturnType<typeof vi.fn>;
}

async function runResettingTurn(
  reset: () => Error,
  options: {
    readonly beforeReset?: () => void;
    /** Consecutive calls, from the second, whose connection drops mid-stream. */
    readonly resets?: number;
    /** The one-shot fast loop (the TB2.1 configuration) or the standard loop. */
    readonly fast?: boolean;
  } = {},
): Promise<ResetRun> {
  const previousHome = process.env.AGENC_HOME;
  const home = mkdtempSync(join(tmpdir(), "agenc-fast-reset-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "agenc-fast-reset-cwd-"));
  mkdirSync(join(cwd, ".git"));
  process.env.AGENC_HOME = home;
  let calls = 0;
  let fastCalls = 0;
  const requests: LLMMessage[][] = [];
  const usage = { promptTokens: 100, completionTokens: 5, totalTokens: 105,
    availability: "reported" as const, provenance: "provider" as const };
  const provider = {
    name: "grok",
    getExecutionProfile: async () => ({
      provider: "grok", model: "grok-4.5", contextWindowTokens: CONTEXT_WINDOW_TOKENS,
      usageReporting: "authoritative" as const, supportsMaxOutputTokens: true,
    }),
    chat: async () => { throw new Error("chat must not run"); },
    chatStream: async (messages: LLMMessage[], onChunk?: (chunk: LLMStreamChunk) => void): Promise<LLMResponse> => {
      calls += 1;
      if (oneShotFastModeActive()) fastCalls += 1;
      requests.push(messages.map((message) => ({ ...message })));
      if (calls === 1) {
        return { content: "", toolCalls: [{ id: "list-once", name: "list_files", arguments: "{}" }],
          finishReason: "tool_calls", model: "grok-4.5", usage };
      }
      if (calls <= 1 + (options.resets ?? 1)) {
        // Mid-stream: part of the answer arrives before the connection drops.
        onChunk?.({ content: PARTIAL, done: false });
        options.beforeReset?.();
        throw reset();
      }
      return { content: "done", toolCalls: [], finishReason: "stop", model: "grok-4.5", usage };
    },
    healthCheck: async () => true,
  } as unknown as LLMProvider;
  const execute = vi.fn(async () => ({ content: "listed" }));
  const { session, events } = mkSession({
    cwd,
    provider,
    registry: {
      tools: [{ name: "list_files", description: "List files", inputSchema: { type: "object" },
        recoveryCategory: "idempotent", execute }],
      toLLMTools: () => [],
      dispatch: execute,
    } as never,
    modelInfo: { slug: "grok-4.5", contextWindow: CONTEXT_WINDOW_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS },
    services: {
      configStore: createTestConfigStore({ base: { provider_outage_wait_ms: 0 } }),
      runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true,
        dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true,
        ...(options.beforeReset !== undefined ? { deadlineAt: 1_000_000 + 120_000, deadlineReserveMs: 30_000 } : {}) }),
    },
  });
  const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "fast-transport-resample", ownerPid: process.pid });
  const client = kernel.bindClient({
    cwd,
    scope: { runId: session.conversationId, sessionId: session.conversationId, autonomous: false },
  });
  Object.assign(session.services, {
    // Every model call goes through this bound client. Without a client the
    // run would be refused; `false` only lets the standard loop run the
    // read-only tool without a transcript store, which this fixture lacks.
    executionAdmission: client,
    admissionRequired: false,
    agentControl: { shutdownAgentTree: async () => undefined },
    permissionModeRegistry: new PermissionModeRegistry({
      ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
    }),
  });
  // A task token allowance makes the task-budget ledger account every attempt.
  Object.assign(session.config, { model: "grok-4.5", taskTokenBudget: 1_000_000 });
  const ctx = mkCtx({
    subId: "turn-reset",
    cwd,
    permissionMode: "bypassPermissions",
    sandboxPolicy: { value: "danger_full_access" },
    modelInfo: { ...mkCtx().modelInfo, slug: "grok-4.5", contextWindow: CONTEXT_WINDOW_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS },
    config: { ...mkCtx().config, bypassFastMode: options.fast ?? true },
  });
  const phases: PhaseEvent[] = [];
  let terminal: ResetRun["terminal"];
  let thrown: unknown;
  try {
    const loop = runTurn(session, ctx, "List the files, then finish.", { exactOutput: true });
    for (;;) {
      const next = await loop.next();
      if (next.done) { terminal = next.value as ResetRun["terminal"]; break; }
      phases.push(next.value);
    }
  } catch (error) {
    thrown = error;
  }
  // Model samples only; a read-only tool takes an observation row of its own.
  const journal = (client.replayJournal?.() ?? []).filter((event) => event.stepId.startsWith("model:"))
    .map((event) => ({
      event: event.event, stepId: event.stepId,
      ...("reason" in event && typeof event.reason === "string" ? { reason: event.reason } : {}),
    }));
  const summary = client.getUsageSummary?.();
  const budget = taskBudgetOf(session);
  kernel.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousHome;
  return {
    calls, fastCalls, requests, events: events as ResetRun["events"], phases, terminal, thrown, journal,
    summary: summary === undefined ? undefined
      : { hasUnknownCost: summary.hasUnknownCost, heldCostUsd: summary.heldCostUsd, modelCalls: summary.modelCalls },
    budget: budget === undefined ? undefined : { tokens: budget.tokens, calls: budget.calls },
    execute,
  };
}

const failureText = (run: ResetRun): string => {
  const failed = run.events.find((event) => event.msg.type === "turn_failed");
  return [run.thrown instanceof Error ? run.thrown.message : "", JSON.stringify(failed?.msg.payload ?? null)].join(" ");
};

const cases = Object.keys(resets).flatMap((kind) => [
  { kind, loop: "one_shot_fast" as const },
  { kind, loop: "standard" as const },
]);

test.each(cases)("a bypass turn in the $loop loop resamples after a mid-stream $kind under execution admission", async ({ kind, loop }) => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const fast = loop === "one_shot_fast";
  const run = await runResettingTurn(resets[kind]!, { fast });
  expect(failureText(run)).not.toMatch(/admission/);
  expect(run.thrown).toBeUndefined();
  expect(run.terminal?.reason).toBe("completed");
  expect(run.phases.at(-1)).toMatchObject({ type: "turn_complete", content: "done" });
  expect(run.events.some((event) => event.msg.type === "turn_failed")).toBe(false);
  // The tool call, the cut reply, then one resample. The fast loop made the
  // first two; the standard loop owns the resample in both configurations.
  expect(run.calls).toBe(3);
  expect(run.fastCalls).toBe(fast ? 2 : 0);
  // The tool from the complete first response ran once; the cut reply had none.
  expect(run.execute).toHaveBeenCalledOnce();
  const resample = JSON.stringify(run.requests[2]);
  expect(resample).toContain("listed");
  expect(resample).not.toContain(PARTIAL);
  // Admission ledger: each physical sample has its own identity, and the cut one
  // stays held unknown after dispatch instead of becoming free.
  const dispatched = run.journal.filter((event) => event.event === "dispatched");
  expect(dispatched).toHaveLength(3);
  expect(new Set(dispatched.map((event) => event.stepId)).size).toBe(3);
  expect(run.journal.filter((event) => event.event === "held_unknown")).toEqual([
    expect.objectContaining({ stepId: dispatched[1]!.stepId, reason: "provider_call_failed_after_dispatch" }),
  ]);
  expect(run.journal.filter((event) => event.event === "reconciled").map((event) => event.stepId))
    .toEqual([dispatched[0]!.stepId, dispatched[2]!.stepId]);
  expect(run.journal.filter((event) => event.event === "denied" || event.event === "voided")).toEqual([]);
  expect(run.summary).toMatchObject({ hasUnknownCost: true });
  // Task budget ledger: three calls, and the cut one is charged its reservation.
  expect(run.budget?.calls).toBe(3);
  expect(run.budget!.tokens).toBeGreaterThan(2 * 105);
  const receipts = run.events.flatMap((event) => event.msg.type === "warning" &&
    (event.msg.payload as { cause?: string }).cause === "transport_recovery" ? [event.msg.payload] : []);
  expect(receipts).toContainEqual(expect.objectContaining({ details: expect.objectContaining({
    outcome: "interrupted", completedToolCallIds: "list-once", toolReplay: false,
    ...(fast ? { loop: "one_shot_fast" } : {}),
  }) }));
});

test("a one-shot bypass resample that is cut again continues on the standard reconnect ladder", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const run = await runResettingTurn(resets.connection_reset!, { resets: 2 });
  expect(failureText(run)).not.toMatch(/admission/);
  expect(run.phases.at(-1)).toMatchObject({ type: "turn_complete", content: "done" });
  expect(run.calls).toBe(4);
  expect(run.fastCalls).toBe(2);
  expect(run.execute).toHaveBeenCalledOnce();
  const dispatched = run.journal.filter((event) => event.event === "dispatched");
  expect(new Set(dispatched.map((event) => event.stepId)).size).toBe(4);
  expect(run.journal.filter((event) => event.event === "held_unknown").map((event) => event.stepId))
    .toEqual([dispatched[1]!.stepId, dispatched[2]!.stepId]);
  expect(run.budget?.calls).toBe(4);
});

test("a one-shot bypass reset with the recovery ladder spent ends on the transport error without a resample", async () => {
  const reserve = recovery.reserveRecoveryReentry;
  vi.spyOn(recovery, "reserveRecoveryReentry").mockImplementation(async (session, state, options) => {
    state.recoveryReentryCount = recovery.MAX_RECOVERY_REENTRIES;
    return reserve(session, state, options);
  });
  const run = await runResettingTurn(resets.connection_reset!);
  expect(run.calls).toBe(2);
  expect(run.execute).toHaveBeenCalledOnce();
  expect(failureText(run)).toMatch(/ECONNRESET/);
  expect(failureText(run)).not.toMatch(/admission/);
  expect(run.journal.filter((event) => event.event === "dispatched")).toHaveLength(2);
  expect(run.journal.filter((event) => event.event === "held_unknown")).toHaveLength(1);
});

test("a one-shot bypass reset after the run deadline ends deadline_reached without a resample", async () => {
  const clock = createFakeRunDeadlineClock();
  setRunDeadlineClockForTests(clock);
  // The connection drops after the deadline has passed.
  const run = await runResettingTurn(resets.connection_reset!, { beforeReset: () => clock.advance(121_000) });
  expect(run.calls).toBe(2);
  expect(run.execute).toHaveBeenCalledOnce();
  expect(failureText(run)).not.toMatch(/admission/);
  expect(run.phases.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "deadline_reached" });
  expect(run.journal.filter((event) => event.event === "dispatched")).toHaveLength(2);
});
