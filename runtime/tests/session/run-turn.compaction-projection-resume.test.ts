import { afterEach, expect, test } from "vitest";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { bindExecutionAdmissionJournal } from "../../src/session/execution-admission-journal.js";
import { shutdownSessionLifecycle } from "../../src/session/lifecycle.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { resumeTurnFromCheckpoint } from "../../src/conversation/thread-manager.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { Session } from "../../src/session/session.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";
import {
  attachCompactionSession,
  createCompactionTransactionHarness,
  type CompactionTransactionHarness,
} from "../helpers/compaction-transaction-harness.js";

const COMPACTION_ENVIRONMENT_KEYS = [
  "AGENC_AUTO_COMPACT_WINDOW",
  "AGENC_AUTOCOMPACT_PCT_OVERRIDE",
  "AGENC_DISABLE_COMPACT",
  "AGENC_DISABLE_AUTO_COMPACT",
] as const;

const previousEnvironment = new Map(
  COMPACTION_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("a committed standard tier is checkpointed before shutdown in the aggressive tier, then continues", async () => {
  process.env.AGENC_AUTO_COMPACT_WINDOW = "1000";
  process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE = "50";
  delete process.env.AGENC_DISABLE_COMPACT;
  delete process.env.AGENC_DISABLE_AUTO_COMPACT;

  const source: LLMMessage[] = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `source-${index}:${"x".repeat(4_000)}`,
  }));
  const aggressiveEntered = Promise.withResolvers<void>();
  let first: Session | undefined;
  let second: Session | undefined;
  let harness: CompactionTransactionHarness | undefined;
  let secondStore: RolloutStore | undefined;
  let resumedKernel: ExecutionAdmissionKernel | undefined;
  let sampleCalls = 0;
  let structuredCalls = 0;
  const modelInfo = {
    ...mkCtx().modelInfo,
    slug: "grok-4.5",
    contextWindow: 64_000,
    maxOutputTokens: 512,
    autoCompactTokenLimit: 100_000,
  };
  const ctx = mkCtx({ modelInfo });
  const registry = {
    tools: [{ name: "Read", description: "read once", inputSchema: { type: "object" },
      requiresApproval: false, recoveryCategory: "read-only",
      execute: async () => ({ content: "read result", isError: false }) }],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "read result", isError: false }),
  } as unknown as ToolRegistry;
  const response = (content: string, tool = false, promptTokens = 3_100,
    completionTokens = 1): LLMResponse => ({
    content,
    toolCalls: tool ? [{ id: "read-once", name: "Read", arguments: "{}" }] : [],
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
      availability: "reported", provenance: "provider" },
    model: "grok-4.5",
    finishReason: tool ? "tool_calls" : "stop",
  });
  try {
    harness = createCompactionTransactionHarness(source, {
      sessionId: "conv-test",
      contextWindowTokens: 64_000,
      maxOutputTokens: 512,
      chat: async (messages) => {
        const content = messages[0]?.content;
        if (typeof content === "string") {
          try {
            const payload = JSON.parse(content) as {
              units?: Array<{ messages: Array<{ tool_call_id?: string; tool_result_sha256?: string }> }>;
              summaries?: Array<{ body: { tool_pairs: Array<{ tool_call_id: string; result_sha256: string }> } }>;
              children?: Array<{ body: { tool_pairs: Array<{ tool_call_id: string; result_sha256: string }> } }>;
            };
            if (payload.units || payload.summaries || payload.children) {
              structuredCalls += 1;
              if (harness?.store.readAll().some((item) => item.type === "compaction_committed")) {
                aggressiveEntered.resolve();
                return await new Promise<LLMResponse>((_resolve, reject) => {
                  first?.abortController.signal.addEventListener("abort", () =>
                    reject(new DOMException("aggressive compaction aborted", "AbortError")),
                  { once: true });
                });
              }
              const toolPairs = payload.units?.flatMap((unit) => unit.messages
                .filter((message) => message.tool_call_id && message.tool_result_sha256)
                .map((message) => ({ tool_call_id: message.tool_call_id!,
                  result_sha256: message.tool_result_sha256! }))) ??
                payload.summaries?.flatMap((summary) => summary.body.tool_pairs) ??
                payload.children?.flatMap((summary) => summary.body.tool_pairs) ?? [];
              return response(JSON.stringify({ narrative: "Bounded summary.", facts: [],
                open_actions: [], tool_pairs: toolPairs }), false, 128, 128);
            }
          } catch (error) {
            if (error instanceof DOMException) throw error;
          }
        }
        sampleCalls += 1;
        if (sampleCalls === 1) {
          modelInfo.autoCompactTokenLimit = 1;
          return response("read first", true);
        }
        return response("completed after restart");
      },
    });
    const firstHarness = mkSession({ cwd: harness.store.store.cwd, provider: harness.provider,
      registry, history: source, modelInfo });
    first = firstHarness.session;
    Object.assign(first.config, { durableTurns: { resume: { requireLease: false } } });
    Object.assign(first.services, { executionAdmission: harness.session.services.executionAdmission,
      admissionRequired: true });
    attachCompactionSession(first, harness);
    first.onBeforeDurableClose(bindExecutionAdmissionJournal(first, first.services.executionAdmission!));
    const running = drain(runTurn(first, ctx, "read then finish"));
    await Promise.race([
      aggressiveEntered.promise,
      running.then(() => {
        throw new Error(`turn ended before aggressive tier: ${JSON.stringify({
          sampleCalls,
          structuredCalls,
          providerInputs: harness?.provider.chat.mock.calls.map((call) => String(call[0]?.[0]?.content).slice(0, 100)),
          events: firstHarness.events.map((event) => event.msg.type),
          warnings: firstHarness.events.filter((event) => event.msg.type === "warning"),
          failures: harness?.store.readAll().filter((item) => item.type === "compaction_failed"),
          rows: harness?.store.readAll().map((item) => item.type),
        })}`);
      }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(
        `aggressive tier was not reached: ${JSON.stringify({
          sampleCalls,
          events: firstHarness.events.map((event) => event.msg.type),
          rows: harness?.store.readAll().map((item) => item.type),
        })}`,
      )), 5_000)),
    ]);
    const beforeShutdown = harness.store.readAll();
    const commitIndex = beforeShutdown.findIndex((item) => item.type === "compaction_committed");
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(beforeShutdown.slice(commitIndex + 1).some((item) => item.type === "event_msg" &&
      item.payload.msg.type === "turn_checkpoint")).toBe(true);
    await shutdownSessionLifecycle({ session: first, skipMemoryExtractionDrain: true });
    await running;
    expect(firstHarness.events.find((event) => event.msg.type === "turn_aborted")?.msg)
      .toMatchObject({ payload: { reason: "daemon_shutdown" } });
    expect(beforeShutdown.filter((item) => item.type === "response_item" &&
      item.payload.role === "tool" && item.payload.toolCallId === "read-once")).toHaveLength(1);
    const secondHarness = mkSession({ cwd: harness.store.store.cwd, provider: harness.provider,
      registry, modelInfo: { ...modelInfo, autoCompactTokenLimit: 100_000 } });
    second = secondHarness.session;
    resumedKernel = new ExecutionAdmissionKernel({ agencHome: harness.store.store.agencHome,
      ownerId: "compaction-resume-test", ownerPid: process.pid });
    const resumedAdmission = resumedKernel.bindClient({ cwd: harness.store.store.cwd,
      scope: { runId: "conv-test", sessionId: "conv-test", autonomous: false } });
    secondStore = new RolloutStore({ cwd: harness.store.store.cwd,
      agencHome: harness.store.store.agencHome, sessionId: "conv-test",
      agencVersion: "0.13.0", sessionTempRoot: harness.store.store.cwd,
      autoStartScheduler: false, resume: true });
    secondStore.open({ sessionId: "conv-test", timestamp: new Date().toISOString(),
      cwd: harness.store.store.cwd, originator: "compaction-resume-test",
      agencVersion: "0.13.0", model: "grok-4.5", modelProvider: "grok" });
    Object.assign(second.config, { durableTurns: { resume: { requireLease: false } } });
    Object.assign(second.services, { executionAdmission: resumedAdmission,
      admissionRequired: true });
    second.mountRolloutStore(secondStore);
    second.eventLog.seedCanonicalHistory(secondStore.readAll()
      .filter((item) => item.type === "event_msg").map((item) => item.payload));
    second.onBeforeDurableClose(bindExecutionAdmissionJournal(second, resumedAdmission));
    const reconstruction = reconstructFromRollout(secondStore.readAll(), {
      checkpointProjection: secondStore.checkpointProjectionContext("tier-shutdown-test"),
    });
    expect(reconstruction.resumableTurns).toHaveLength(1);
    expect(reconstruction.resumableTurns[0]?.checkpointIntegrityStatus).toBe("valid");
    expect(reconstruction.resumableTurns[0]?.danglingToolUses).toHaveLength(0);
    await expect(resumeTurnFromCheckpoint(second, reconstruction, undefined, {
      ctx: mkCtx({ ...ctx, modelInfo: { ...modelInfo, autoCompactTokenLimit: 100_000 } }),
    })).resolves.toMatchObject({ resumed: true });
    expect(sampleCalls).toBe(2);
    expect(secondHarness.events.some((event) => event.msg.type === "turn_complete")).toBe(true);
    expect(secondHarness.events.some((event) => event.msg.type === "turn_failed")).toBe(false);
    expect(secondStore.readAll().filter((item) => item.type === "response_item" &&
      item.payload.role === "tool" && item.payload.toolCallId === "read-once")).toHaveLength(1);
  } finally {
    await second?.shutdown().catch(() => undefined);
    await first?.shutdown().catch(() => undefined);
    resumedKernel?.close();
    secondStore?.close();
    harness?.close();
  }
});

test("a later ordinary turn resumes after a completed compacting turn and daemon shutdown", async () => {
  process.env.AGENC_AUTO_COMPACT_WINDOW = "1000";
  process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE = "50";
  delete process.env.AGENC_DISABLE_COMPACT;
  delete process.env.AGENC_DISABLE_AUTO_COMPACT;

  const source: LLMMessage[] = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `source-${index}:${"x".repeat(4_000)}`,
  }));
  const laterTurnEntered = Promise.withResolvers<void>();
  let first: Session | undefined;
  let resumed: Session | undefined;
  let harness: CompactionTransactionHarness | undefined;
  let resumedStore: RolloutStore | undefined;
  let resumedKernel: ExecutionAdmissionKernel | undefined;
  let sampleCalls = 0;
  const modelInfo = {
    ...mkCtx().modelInfo,
    slug: "grok-4.5",
    contextWindow: 64_000,
    maxOutputTokens: 512,
    autoCompactTokenLimit: 100_000,
  };
  const ctx = mkCtx({ modelInfo });
  const registry = {
    tools: [{ name: "Read", description: "read once", inputSchema: { type: "object" },
      requiresApproval: false, recoveryCategory: "read-only",
      execute: async () => ({ content: "read result", isError: false }) }],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "read result", isError: false }),
  } as unknown as ToolRegistry;
  const response = (content: string, tool = false, promptTokens = 3_100,
    completionTokens = 1, toolCallId = "read-once"): LLMResponse => ({
    content,
    toolCalls: tool ? [{ id: toolCallId, name: "Read", arguments: "{}" }] : [],
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
      availability: "reported", provenance: "provider" },
    model: "grok-4.5",
    finishReason: tool ? "tool_calls" : "stop",
  });
  try {
    harness = createCompactionTransactionHarness(source, {
      sessionId: "conv-test",
      contextWindowTokens: 64_000,
      maxOutputTokens: 512,
      chat: async (messages) => {
        const content = messages[0]?.content;
        if (typeof content === "string") {
          try {
            const payload = JSON.parse(content) as {
              units?: Array<{ messages: Array<{ tool_call_id?: string; tool_result_sha256?: string }> }>;
              summaries?: Array<{ body: { tool_pairs: Array<{ tool_call_id: string; result_sha256: string }> } }>;
              children?: Array<{ body: { tool_pairs: Array<{ tool_call_id: string; result_sha256: string }> } }>;
            };
            if (payload.units || payload.summaries || payload.children) {
              const toolPairs = payload.units?.flatMap((unit) => unit.messages
                .filter((message) => message.tool_call_id && message.tool_result_sha256)
                .map((message) => ({ tool_call_id: message.tool_call_id!,
                  result_sha256: message.tool_result_sha256! }))) ??
                payload.summaries?.flatMap((summary) => summary.body.tool_pairs) ??
                payload.children?.flatMap((summary) => summary.body.tool_pairs) ?? [];
              modelInfo.autoCompactTokenLimit = 100_000;
              return response(JSON.stringify({ narrative: "Bounded summary.", facts: [],
                open_actions: [], tool_pairs: toolPairs }), false, 128, 128);
            }
          } catch (error) {
            if (error instanceof DOMException) throw error;
          }
        }
        sampleCalls += 1;
        if (sampleCalls === 1) {
          modelInfo.autoCompactTokenLimit = 1;
          return response("read first", true);
        }
        if (sampleCalls === 3) return response("read later", true, 3_100, 1, "read-later");
        if (sampleCalls === 4) {
          laterTurnEntered.resolve();
          return await new Promise<LLMResponse>((_resolve, reject) => {
            first?.abortController.signal.addEventListener("abort", () =>
              reject(new DOMException("later turn aborted", "AbortError")),
            { once: true });
          });
        }
        return response(sampleCalls === 2 ? "first turn complete" : "continued after restart");
      },
    });
    const firstHarness = mkSession({ cwd: harness.store.store.cwd, provider: harness.provider,
      registry, history: source, modelInfo });
    first = firstHarness.session;
    Object.assign(first.config, { durableTurns: { resume: { requireLease: false } } });
    Object.assign(first.services, { executionAdmission: harness.session.services.executionAdmission,
      admissionRequired: true });
    attachCompactionSession(first, harness);
    first.onBeforeDurableClose(bindExecutionAdmissionJournal(first, first.services.executionAdmission!));

    await drain(runTurn(first, ctx, "read then finish"));
    expect(firstHarness.events.some((event) => event.msg.type === "turn_complete")).toBe(true);
    const completedRows = harness.store.readAll();
    expect(completedRows.some((item) => item.type === "compaction_committed")).toBe(true);
    expect(completedRows.some((item) => item.type === "compaction_committed" &&
      item.payload.replacement_history.some((message) => message.id !== undefined))).toBe(true);

    const later = drain(first.runTurn("next request", { subId: "turn-later" }));
    await Promise.race([
      laterTurnEntered.promise,
      later.then(() => { throw new Error("later turn ended before shutdown"); }),
      new Promise<never>((_resolve, reject) => setTimeout(() =>
        reject(new Error("later turn did not reach the provider")), 5_000)),
    ]);
    expect(harness.store.readAll().some((item) => item.type === "event_msg" &&
      item.payload.msg.type === "turn_checkpoint" &&
      item.payload.msg.payload.turnId === "turn-later")).toBe(true);
    await shutdownSessionLifecycle({ session: first, skipMemoryExtractionDrain: true });
    await later;
    expect(firstHarness.events.filter((event) => event.msg.type === "turn_aborted").at(-1)?.msg)
      .toMatchObject({ payload: { reason: "daemon_shutdown" } });

    const resumedHarness = mkSession({ cwd: harness.store.store.cwd, provider: harness.provider,
      registry, modelInfo });
    resumed = resumedHarness.session;
    resumedKernel = new ExecutionAdmissionKernel({ agencHome: harness.store.store.agencHome,
      ownerId: "later-turn-resume-test", ownerPid: process.pid });
    const admission = resumedKernel.bindClient({ cwd: harness.store.store.cwd,
      scope: { runId: "conv-test", sessionId: "conv-test", autonomous: false } });
    resumedStore = new RolloutStore({ cwd: harness.store.store.cwd,
      agencHome: harness.store.store.agencHome, sessionId: "conv-test",
      agencVersion: "0.13.0", sessionTempRoot: harness.store.store.cwd,
      autoStartScheduler: false, resume: true });
    resumedStore.open({ sessionId: "conv-test", timestamp: new Date().toISOString(),
      cwd: harness.store.store.cwd, originator: "later-turn-resume-test",
      agencVersion: "0.13.0", model: "grok-4.5", modelProvider: "grok" });
    Object.assign(resumed.config, { durableTurns: { resume: { requireLease: false } } });
    Object.assign(resumed.services, { executionAdmission: admission, admissionRequired: true });
    resumed.mountRolloutStore(resumedStore);
    resumed.eventLog.seedCanonicalHistory(resumedStore.readAll()
      .filter((item) => item.type === "event_msg").map((item) => item.payload));
    resumed.onBeforeDurableClose(bindExecutionAdmissionJournal(resumed, admission));
    const reconstruction = reconstructFromRollout(resumedStore.readAll(), {
      checkpointProjection: resumedStore.checkpointProjectionContext("later-turn-resume-test"),
    });
    expect(reconstruction.resumableTurns).toHaveLength(1);
    expect(reconstruction.resumableTurns[0]?.checkpointIntegrityStatus).toBe("valid");
    await expect(resumeTurnFromCheckpoint(resumed, reconstruction, undefined, {
      ctx: mkCtx({ subId: "turn-later", modelInfo }),
    })).resolves.toMatchObject({ resumed: true });
    expect(sampleCalls).toBe(5);
    expect(resumedHarness.events.some((event) => event.msg.type === "turn_complete")).toBe(true);
  } finally {
    await resumed?.shutdown().catch(() => undefined);
    await first?.shutdown().catch(() => undefined);
    resumedKernel?.close();
    resumedStore?.close();
    harness?.close();
  }
});
