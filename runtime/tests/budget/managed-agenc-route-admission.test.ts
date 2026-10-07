// The managed AgenC DeepSeek route reaches OpenRouter through the AgenC
// gateway, so admission sees the concrete identity openrouter /
// deepseek/deepseek-v4.1-flash. The public OpenRouter row for that id is
// deliberately unpriced, so before this fix every managed call reserved the
// registry's conservative ceiling ($150/M input, $600/M output): about $41.72
// for a 22,116-token prompt with the default 64,000-token output allowance.
// Any hard USD cap below that refused the managed model outright.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { ProviderTokenCountCapability } from "../../src/llm/token-accounting.js";
import type { LLMMessage, LLMProvider, LLMResponse } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";

const SINGLE_SLOT_LIMITS = { global: 1, workspace: 1, session: 1, parent: 1, provider: 1 } as const;
const ROUTE = "deepseek/deepseek-v4.1-flash";

test("a hard USD cap admits and settles a managed DeepSeek call at the route's rates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agenc-managed-deepseek-admission-"));
  const workspace = join(directory, "workspace");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  const kernel = new ExecutionAdmissionKernel({
    agencHome: join(directory, "home"),
    ownerId: "managed-deepseek-admission",
    ownerPid: process.pid,
    limits: SINGLE_SLOT_LIMITS,
  });
  try {
    const client = kernel.bindClient({
      cwd: workspace,
      scope: { runId: "managed-deepseek", sessionId: "managed-deepseek", autonomous: false, maxCostUsd: 1 },
    });
    const session = {
      conversationId: "managed-deepseek",
      services: { executionAdmission: client, admissionRequired: true, agentControl: {} },
      abortTerminal: vi.fn(),
    } as unknown as Session;
    const provider = {
      name: "agenc",
      getExecutionProfile: async () => ({
        provider: "openrouter",
        model: ROUTE,
        usageReporting: "authoritative" as const,
        supportsMaxOutputTokens: true,
      }),
      // Pin the counted prompt to the live run's 22,116 input tokens.
      tokenCountCapability: {
        capabilityVersion: "fixed-count-v1",
        adapterRevision: "fixed-count-v1",
        configurationRevision: "managed-deepseek",
        countTokens: async () => ({
          inputTokens: 22_116,
          complete: true as const,
          confidence: "exact" as const,
          countedComponents: ["messages" as const, "provider_framing" as const],
        }),
      } satisfies ProviderTokenCountCapability,
    } as unknown as LLMProvider;
    const messages: LLMMessage[] = [{ role: "user", content: "synthetic probe" }];
    const answer: LLMResponse = {
      content: "ok",
      toolCalls: [],
      usage: {
        promptTokens: 22_116,
        completionTokens: 5,
        totalTokens: 22_121,
        availability: "reported",
        provenance: "provider",
      },
      model: `${ROUTE}-20260910`,
      finishReason: "stop",
    };

    await expect(runAdmittedModelCall({
      session,
      provider,
      messages,
      stepId: "managed-deepseek-1",
      model: ROUTE,
      providerName: "agenc",
      options: { model: ROUTE, maxOutputTokens: 64_000, contextWindowTokens: 1_048_576 },
      invoke: async () => answer,
    })).resolves.toBe(answer);

    // 22,116 input at $0.30/M plus 5 output at $1.20/M.
    const usage = client.getUsageSummary?.();
    expect(usage).toMatchObject({ costUsd: expect.closeTo(0.0066408, 9), hasUnknownCost: false, heldCostUsd: 0 });
    expect(usage?.costEstimated).toBeUndefined();
    expect(usage?.models).toEqual([
      expect.objectContaining({ provider: "openrouter", model: ROUTE, costUsd: expect.closeTo(0.0066408, 9) }),
    ]);
  } finally {
    kernel.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
