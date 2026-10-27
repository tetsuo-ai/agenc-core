import { afterEach, expect, test, vi } from "vitest";

import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import { LLMContextWindowExceededError } from "../../src/llm/errors.js";
import { tokenAccountingService } from "../../src/llm/token-accounting.js";
import type { LLMChatOptions, LLMMessage, LLMResponse } from "../../src/llm/types.js";
import { bindExecutionAdmissionJournal } from "../../src/session/execution-admission-journal.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { createAllowAdmissionHarness } from "../budget/admission-test-harness.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import {
  attachCompactionSession,
  createCompactionTransactionHarness,
} from "../helpers/compaction-transaction-harness.js";

const MODEL = "deepseek-flash";
const COMPACTION_ENVIRONMENT_KEYS = [
  "AGENC_AUTO_COMPACT_WINDOW",
  "AGENC_AUTOCOMPACT_PCT_OVERRIDE",
  "AGENC_DISABLE_COMPACT",
  "AGENC_DISABLE_AUTO_COMPACT",
] as const;
const previousEnvironment = new Map(COMPACTION_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  setAutoCompactImplForTests(null);
  tokenAccountingService.clear();
  vi.restoreAllMocks();
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * DeepSeek's own prompt count for a request: about 4.3 bytes of request JSON per token, the density of recorded
 * DeepSeek requests (2026-10-20), where AgenC's conservative fallback was 2.45 times the count.
 */
function deepseekPromptTokens(messages: readonly LLMMessage[], options: LLMChatOptions | undefined): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify({
    system: options?.systemPrompt ?? "",
    tools: options?.tools ?? [],
    messages,
  }), "utf8") / 4.3);
}

/** One of the gate's scenario 7 reading files: 180 numbered prose lines, about 17 KB. */
function readingPart(index: number): string {
  return [`# Reading ${index}`, `Marker: SECTION_${index}`, ...Array.from({ length: 180 }, (_, line) =>
    `Line ${String(line).padStart(3, "0")}: record ${index} item ${line} describes cedar meadow lantern orbit parcel canyon violet station.`,
  )].join("\n");
}

function usage(promptTokens: number): LLMResponse["usage"] {
  return { promptTokens, completionTokens: 20, totalTokens: promptTokens + 20, availability: "reported", provenance: "provider" };
}

function readRegistry(): ToolRegistry {
  let reads = 0;
  const read = async () => ({ content: readingPart(reads++), isError: false });
  return {
    tools: [{ name: "read_part", description: "Read the next part", inputSchema: { type: "object" },
      requiresApproval: false, recoveryCategory: "idempotent", execute: read }],
    toLLMTools: () => [],
    dispatch: read,
  } as unknown as ToolRegistry;
}

test("a long DeepSeek turn passes the fallback's compaction point without compacting, on estimates that stay upper bounds", async () => {
  delete process.env.AGENC_AUTO_COMPACT_WINDOW;
  delete process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE;
  delete process.env.AGENC_DISABLE_COMPACT;
  delete process.env.AGENC_DISABLE_AUTO_COMPACT;
  const parts = 8;
  const provider = mkProvider();
  Object.assign(provider, { name: "deepseek" });
  const prompts: number[] = [];
  provider.chatStream = async (messages, _onChunk, options): Promise<LLMResponse> => {
    const promptTokens = deepseekPromptTokens(messages, options);
    prompts.push(promptTokens);
    const more = prompts.length <= parts;
    return {
      content: more ? `Reading part ${prompts.length - 1}.` : "READING_COMPLETE",
      toolCalls: more ? [{ id: `read-${prompts.length}`, name: "read_part", arguments: "{}" }] : [],
      usage: usage(promptTokens),
      model: MODEL,
      finishReason: more ? "tool_calls" : "stop",
    };
  };
  const admission = createAllowAdmissionHarness();
  // Model calls go through admission, which records DeepSeek's usage; tool
  // effects need no durable journal in this in-memory session.
  const { session, events } = mkSession({ provider, registry: readRegistry(), model: MODEL, services: {
    executionAdmission: admission.admission,
    admissionRequired: false,
    runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true }),
  } });
  // An 80,000-token window compacts at 60,000 accounted tokens. The eight
  // parts bring the real prompt to about 34,000 tokens, which the
  // uncalibrated fallback counts as about 83,000: past the threshold from
  // the sixth part on, and past the window itself at the end.
  const ctx = mkCtx({ provider, modelProviderId: "deepseek", modelInfo: {
    ...mkCtx().modelInfo, slug: MODEL, contextWindow: 80_000, maxOutputTokens: 8_192,
    effectiveContextWindowPercent: 100,
  } });
  let compactions = 0;
  setAutoCompactImplForTests(async () => {
    compactions++;
    return { wasCompacted: false, skippedCode: "no_shrink", consecutiveFailures: 1 };
  });

  await drain(runTurn(session, ctx, "Read every part, one per call, then reply READING_COMPLETE."));

  const terminals = events.map((event) => classifyTurnTerminal(event.msg));
  expect(terminals, JSON.stringify(events.map((event) => event.msg))).toContainEqual(
    expect.objectContaining({ outcome: "completed", code: 0 }),
  );
  expect(compactions).toBe(0);
  expect(prompts).toHaveLength(parts + 1);
  expect(prompts.at(-1)!).toBeGreaterThan(30_000);
  const accounted = admission.acquire.mock.calls
    .filter(([input]) => input.kind === "model_turn")
    .map(([input]) => input.maxInputTokens);
  expect(accounted).toHaveLength(prompts.length);
  // The first request is the conservative fallback. Every later one is
  // anchored on DeepSeek's report and stays above the real prompt; each new
  // part is still counted at the fallback rate, so the margin narrows as the
  // measured history grows.
  expect(accounted[0]! / prompts[0]!).toBeGreaterThan(2);
  for (let index = 1; index < prompts.length; index += 1) {
    expect(accounted[index]!).toBeGreaterThanOrEqual(prompts[index]!);
  }
  expect(accounted.at(-1)! / prompts.at(-1)!).toBeLessThan(1.4);
});

test("a context-length refusal of a calibrated DeepSeek request compacts the history and retries", async () => {
  delete process.env.AGENC_DISABLE_COMPACT;
  delete process.env.AGENC_DISABLE_AUTO_COMPACT;
  delete process.env.AGENC_AUTO_COMPACT_WINDOW;
  delete process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE;
  const source: LLMMessage[] = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `earlier-${index}: ${readingPart(100 + index).slice(0, 6_000)}`,
  }));
  const summary = JSON.stringify({ narrative: "Read the earlier parts; continue reading.", facts: [], open_actions: [] });
  const mainPrompts: number[] = [];
  let summaries = 0;
  let refusedPrompt = 0;
  const harness = createCompactionTransactionHarness(source, {
    sessionId: "conv-test",
    contextWindowTokens: 64_000,
    maxOutputTokens: 512,
    chat: async (messages, options): Promise<LLMResponse> => {
      const promptTokens = deepseekPromptTokens(messages, options);
      // The compaction summarizer's own system prompt names its stage.
      if (/Stage: (?:map|reduce|final)\./u.test(options?.systemPrompt ?? "")) {
        summaries++;
        return { content: summary, toolCalls: [], usage: usage(promptTokens), model: MODEL, finishReason: "stop" };
      }
      mainPrompts.push(promptTokens);
      if (mainPrompts.length === 1) {
        return { content: "Reading the next part.", toolCalls: [{ id: "read-1", name: "read_part", arguments: "{}" }],
          usage: usage(promptTokens), model: MODEL, finishReason: "tool_calls" };
      }
      if (mainPrompts.length === 2) {
        // The provider's limit is smaller than the window AgenC was told: it
        // refuses the request that the calibrated estimate admitted.
        refusedPrompt = promptTokens;
        throw new LLMContextWindowExceededError("deepseek",
          `This model's maximum context length is 16384 tokens. However, you requested ${promptTokens + 512} tokens ` +
          `(${promptTokens} in the messages, 512 in the completion). Please reduce the length of the messages or completion.`);
      }
      return { content: "READING_COMPLETE", toolCalls: [], usage: usage(promptTokens), model: MODEL, finishReason: "stop" };
    },
  });
  Object.assign(harness.provider, {
    name: "deepseek",
    tokenCountCapability: undefined,
    getExecutionProfile: async () => ({
      provider: "deepseek", model: MODEL, contextWindowTokens: 64_000,
      usageReporting: "authoritative" as const, supportsMaxOutputTokens: true,
    }),
  });
  const overflow = vi.spyOn(tokenAccountingService, "recordContextOverflow");
  const { session, events } = mkSession({ cwd: harness.store.store.cwd, provider: harness.provider,
    registry: readRegistry(), history: source, model: MODEL,
    modelInfo: { slug: MODEL, contextWindow: 64_000, maxOutputTokens: 512 } });
  Object.assign(session.config, { durableTurns: { resume: { requireLease: false } } });
  Object.assign(session.services, { executionAdmission: harness.session.services.executionAdmission,
    admissionRequired: true });
  attachCompactionSession(session, harness);
  session.onBeforeDurableClose(bindExecutionAdmissionJournal(session, session.services.executionAdmission!));
  const ctx = mkCtx({ provider: harness.provider, modelProviderId: "deepseek", modelInfo: {
    ...mkCtx().modelInfo, slug: MODEL, contextWindow: 64_000, maxOutputTokens: 512,
    effectiveContextWindowPercent: 100,
  } });
  try {
    await drain(runTurn(session, ctx, "Read the next part, then reply READING_COMPLETE."));

    const messages = events.map((event) => event.msg);
    expect(messages.map((msg) => classifyTurnTerminal(msg)), JSON.stringify(messages)).toContainEqual(
      expect.objectContaining({ outcome: "completed", code: 0 }),
    );
    expect(overflow).toHaveBeenCalledOnce();
    expect(overflow.mock.calls[0]![1]).toContain(`(${refusedPrompt} in the messages`);
    expect(summaries).toBeGreaterThanOrEqual(1);
    expect(harness.store.readAll().some((item) => item.type === "compaction_committed")).toBe(true);
    expect(mainPrompts).toHaveLength(3);
    expect(mainPrompts[2]!).toBeLessThan(refusedPrompt);
    // Every main request was admitted on an estimate at or above DeepSeek's
    // count; the refused one only exceeded the provider's smaller limit.
    const admitted = messages.flatMap((msg) => msg.type === "execution_admission" &&
      msg.payload.event === "dispatched" && msg.payload.stepId.startsWith("model:") &&
      typeof msg.payload.reservedTokens === "number"
      ? [msg.payload.reservedTokens - Number((msg.payload.details as { maxOutputTokens?: number } | undefined)?.maxOutputTokens ?? 0)]
      : []);
    expect(admitted).toHaveLength(3);
    admitted.forEach((accounted, index) => expect(accounted).toBeGreaterThanOrEqual(mainPrompts[index]!));
    expect(admitted[1]! / mainPrompts[1]!).toBeLessThan(1.5);
  } finally {
    await session.shutdown().catch(() => undefined);
    harness.close();
  }
});
