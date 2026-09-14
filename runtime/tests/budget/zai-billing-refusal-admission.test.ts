// Terminal-Bench 4.0, 2026-09-14: an admitted GLM-5.3 call refused for an exhausted Z.AI balance (HTTP 429, code 1113,
// no content-type header) must end as a billing error after its single wire attempt, not as a retryable rate limit.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { LLMProviderError, LLMRateLimitError } from "../../src/llm/errors.js";
import { ZaiProvider } from "../../src/llm/providers/zai/index.js";
import type { LLMMessage } from "../../src/llm/types.js";
import { StreamModelError } from "../../src/phases/stream-model.js";
import { isTransientProviderError } from "../../src/recovery/api-errors.js";
import { isRetryableStreamError } from "../../src/session/run-turn-stream-retry.js";
import type { Session } from "../../src/session/session.js";

test("an admitted Z.AI call refused for billing fails after one wire attempt and keeps its charge unknown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agenc-zai-billing-admission-"));
  const workspace = join(directory, "workspace");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  const kernel = new ExecutionAdmissionKernel({
    agencHome: join(directory, "home"),
    ownerId: "zai-billing-refusal",
    ownerPid: process.pid,
    limits: { global: 1, workspace: 1, session: 1, parent: 1, provider: 1 },
  });
  const client = kernel.bindClient({
    cwd: workspace,
    scope: { runId: "zai-billing", sessionId: "zai-billing", autonomous: false, maxCostUsd: 10 },
  });
  const hold = vi.spyOn(client, "holdUnknown");
  const reconcile = vi.spyOn(client, "reconcile");
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(
    new TextEncoder().encode(
      '{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}',
    ),
    { status: 429 },
  ));
  const model = "glm-5.3";
  const messages: LLMMessage[] = [{ role: "user", content: "synthetic probe" }];
  const provider = new ZaiProvider({ apiKey: "synthetic-test", model, fetchImpl });
  const session = {
    conversationId: "zai-billing",
    services: { executionAdmission: client, admissionRequired: true, agentControl: {} },
    abortTerminal: vi.fn(),
  } as unknown as Session;
  try {
    const error = await runAdmittedModelCall({
      session, provider, messages, stepId: "refused", model, providerName: "zai",
      options: { maxOutputTokens: 100, contextWindowTokens: 4096 },
      invoke: (options) => {
        expect(options.singleWireAttempt).toBe(true);
        return provider.chatStream(messages, () => undefined, options);
      },
    }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMProviderError);
    expect(error).not.toBeInstanceOf(LLMRateLimitError);
    expect(String(error)).toMatch(/code 1113.*billing/i);
    expect(isTransientProviderError(error)).toBe(false);
    expect(isRetryableStreamError(new StreamModelError(error))).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
    // The refusal came after dispatch and reported no usage, so the charge stays unknown; it is never claimed as zero.
    expect(hold).toHaveBeenCalledExactlyOnceWith(expect.any(String), "provider_call_failed_after_dispatch");
    expect(reconcile).not.toHaveBeenCalled();
    expect(client.getUsageSummary?.()).toMatchObject({ hasUnknownCost: true });
    expect(kernel.activeCount).toBe(0);
    expect(kernel.queuedCount).toBe(0);
  } finally {
    kernel.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
