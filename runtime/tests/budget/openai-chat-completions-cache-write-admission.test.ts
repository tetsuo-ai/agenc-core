// Codex review, P1: unlike Responses' input_tokens_details.cache_write_tokens,
// Chat Completions has no field for prompt-cache writes, so a real write on
// that path (OpenAI, useResponsesApi: false) is folded into prompt_tokens
// with no way to tell it apart from ordinary input. Admission already
// reserves a hard USD cap at the worst input rate including cache writes
// (maximumTokenCostUsd, admitted-model-call.ts), but before this fix,
// reconciliation priced the same tokens as ordinary input, releasing too
// much of that reservation. A later call could then be admitted after the
// real cumulative spend had already crossed the cap.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import type { ProviderTokenCountCapability } from "../../src/llm/token-accounting.js";
import type { LLMMessage } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";

const SINGLE_SLOT_LIMITS = { global: 1, workspace: 1, session: 1, parent: 1, provider: 1 } as const;

function chatCompletionsBody(
  model: string,
  usage: { readonly prompt: number; readonly completion: number; readonly cached?: number },
): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_cache_write_admission",
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
        prompt_tokens_details: { cached_tokens: usage.cached ?? 0 },
        // Deliberately no cache_write_tokens: Chat Completions never reports
        // one, which is exactly the gap this test guards.
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * Pin the counted input tokens used for admission's reservation to an exact
 * value, decoupled from the real tokenizer. The reservation must cover
 * whatever the mocked response later reports as usage, or reconciliation
 * trips the unrelated `provider_overrun` guard (actual tokens/cost exceeding
 * THIS call's own reservation) before the cache-write pricing bug is even
 * exercised.
 */
function withFixedInputTokens(
  provider: OpenAIProvider,
  inputTokens: number,
  configurationRevision: string,
): void {
  Object.assign(provider, {
    tokenCountCapability: {
      capabilityVersion: "fixed-count-v1",
      adapterRevision: "fixed-count-v1",
      configurationRevision,
      countTokens: async () => ({
        inputTokens,
        complete: true as const,
        confidence: "exact" as const,
        countedComponents: ["messages" as const, "provider_framing" as const],
      }),
    } satisfies ProviderTokenCountCapability,
  });
}

test("a Chat Completions cache write is charged at the cache-write rate, so a later call over the hard cap is refused", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agenc-chat-completions-cache-write-"));
  const workspace = join(directory, "workspace");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  const kernel = new ExecutionAdmissionKernel({
    agencHome: join(directory, "home"),
    ownerId: "chat-completions-cache-write",
    ownerPid: process.pid,
    limits: SINGLE_SLOT_LIMITS,
  });
  try {
    // $0.5 hard cap. GPT-6 Sol standard rates: input $2/M, output $10/M,
    // cache write $2.5/M (COST_TIER_GPT_6_SOL, session/cost.ts).
    //
    // Call 1's reservation is pinned to exactly the 100,000 input + 1,000
    // output tokens its mocked response goes on to report, at the worst
    // (cache-write) rate: $0.26. It reports those 100,000 prompt tokens with
    // none of them cached and no cache_write_tokens field at all -- exactly
    // what a real cache write looks like on the Chat Completions wire.
    // Reconciled correctly (as cache writes) that is 100,000 * $2.5/M +
    // 1,000 * $10/M = $0.26, matching the reservation. Reconciled as the bug
    // does (ordinary input) it is only 100,000 * $2/M + 1,000 * $10/M = $0.21.
    //
    // Call 2 reserves a large output allotment (dominated by the $10/M
    // output rate; its pinned 100-token input contributes a fraction of a
    // cent) that costs about $0.26 to reserve. That fits in the $0.29 the
    // cap has left after call 1's buggy $0.21 charge, but not in the $0.24
    // left after call 1's correct $0.26 charge.
    const client = kernel.bindClient({
      cwd: workspace,
      scope: {
        runId: "cache-write",
        sessionId: "cache-write",
        autonomous: false,
        maxCostUsd: 0.5,
      },
    });
    const reconcile = vi.spyOn(client, "reconcile");
    const model = "gpt-6-sol";
    const messages: LLMMessage[] = [{ role: "user", content: "synthetic probe" }];
    const session = {
      conversationId: "cache-write",
      services: { executionAdmission: client, admissionRequired: true, agentControl: {} },
      abortTerminal: vi.fn(),
    } as unknown as Session;

    const firstFetch = vi.fn<typeof fetch>().mockImplementation(async () =>
      chatCompletionsBody(model, { prompt: 100_000, completion: 1_000, cached: 0 }));
    const firstProvider = new OpenAIProvider({
      apiKey: "sk-test",
      model,
      useResponsesApi: false,
      fetchImpl: firstFetch,
    });
    withFixedInputTokens(firstProvider, 100_000, "cache-write-1");

    await runAdmittedModelCall({
      session,
      provider: firstProvider,
      messages,
      stepId: "cache-write-1",
      model,
      providerName: "openai",
      options: { maxOutputTokens: 1_000, contextWindowTokens: 1_050_000 },
      invoke: (options) => firstProvider.chat(messages, options),
    });

    expect(String(firstFetch.mock.calls[0]?.[0])).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    const PER_M = 1 / 1_000_000;
    const chargedFirst = reconcile.mock.calls[0]?.[1]?.costUsd;
    expect(chargedFirst).toBeCloseTo(100_000 * 2.5 * PER_M + 1_000 * 10 * PER_M, 9);

    const secondFetch = vi.fn<typeof fetch>();
    const secondProvider = new OpenAIProvider({
      apiKey: "sk-test",
      model,
      useResponsesApi: false,
      fetchImpl: secondFetch,
    });
    withFixedInputTokens(secondProvider, 100, "cache-write-2");

    await expect(
      runAdmittedModelCall({
        session,
        provider: secondProvider,
        messages,
        stepId: "cache-write-2",
        model,
        providerName: "openai",
        options: { maxOutputTokens: 26_000, contextWindowTokens: 1_050_000 },
        invoke: (options) => secondProvider.chat(messages, options),
      }),
    ).rejects.toMatchObject({ reason: "budget_exceeded" });
    expect(secondFetch).not.toHaveBeenCalled();
  } finally {
    kernel.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
