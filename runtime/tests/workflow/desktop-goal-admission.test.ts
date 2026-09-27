import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/desktop-goal-providers.js";
import { mergeDaemonClientEnvironment } from "../../src/app-server/client-env-snapshot.js";
import { requireProviderRuntimeCredential, resolveProviderRuntimeAuthority } from "../../src/llm/provider-options.js";
import { resolveReasoningEffort } from "../../src/llm/reasoning-effort.js";
import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { createAllowAdmissionHarness } from "../budget/admission-test-harness.js";
import type { ProviderName, LLMProvider, LLMChatOptions } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";

// Existing main-branch pricing gaps are explicit release exceptions, not
// zero-cost fallbacks. Meta pricing is owned by open PR #2768; the others
// need separately reviewed pricing/billing contracts. Keep the hard cap closed.
const unpriced: Record<string, string> = {
  meta: "Muse Spark 1.3 pricing is tracked in #2768",
  qwen: "Qwen 3.8 Max has no registered USD rates",
  "qwen-token-plan": "Token Plan has no per-call USD cost contract",
  "ollama-cloud": "Ollama Cloud subscription has no per-call USD cost contract",
  "zai-coding-plan": "Coding Plan has no per-call USD cost contract",
};
const dynamic: Record<string, string> = {
  agenc: "Account backend discovers authorized models and concrete provider at runtime; agenc is an alias.",
  venice: "Preset uses an endpoint-discovered model through openai-compatible; Desktop has no static default.",
};

describe("Desktop Goal default-provider release admission gate", () => {
  it("enumerates every provider including dynamic exceptions", () => {
    expect(fixture.rows).toHaveLength(25);
    expect(fixture.rows.map(row => row.provider)).toEqual(expect.arrayContaining(Object.keys(dynamic)));
  });
  for (const row of fixture.rows) {
    if (dynamic[row.provider]) {
      it(`explicit exception: ${row.provider}: ${dynamic[row.provider]}`, () => {
        expect(row.model === null || row.model === "agenc").toBe(true);
      });
      continue;
    }
    for (const effort of row.efforts.length ? row.efforts : [undefined]) {
      it(`${unpriced[row.provider] ? "EXCEPTION " : ""}${row.provider} / ${row.model} / ${effort ?? "no effort dial"}`, async () => {
        const model = row.model!;
        const providerName = row.provider as ProviderName;
        const overrides = row.key ? { [row.key]: "test-current-credential" } : row.provider === "amazon-bedrock"
          ? { AWS_ACCESS_KEY_ID: "test-access", AWS_SECRET_ACCESS_KEY: "test-secret", AWS_REGION: "us-east-1" } : {};
        const env = mergeDaemonClientEnvironment({}, overrides)!;
        const authority = await resolveProviderRuntimeAuthority(providerName, { model }, env);
        expect(() => requireProviderRuntimeCredential(providerName, authority)).not.toThrow();
        if (effort !== undefined) expect(resolveReasoningEffort({ provider: providerName, model }).levels).toContain(effort);
        const admission = createAllowAdmissionHarness({ scope: { maxCostUsd: 2, hasHardCostCap: true } });
        const session = { conversationId: "wf-release-gate", services: { executionAdmission: admission.admission, admissionRequired: true }, abortTerminal: vi.fn() } as unknown as Session;
        const provider = { name: providerName, getExecutionProfile: async () => ({ usageReporting: "authoritative", supportsMaxOutputTokens: true }) } as unknown as LLMProvider;
        const invoke = vi.fn(async () => ({ content: "ok", toolCalls: [], model, finishReason: "stop" as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, availability: "reported" as const, provenance: "provider" as const } }));
        const call = runAdmittedModelCall({ session, provider, model, providerName, messages: [{ role: "user", content: "Fix addition" }],
          options: { maxOutputTokens: 128, ...(effort ? { reasoningEffort: effort } : {}) } as LLMChatOptions,
          stepId: "workflow.plan:first-model-call", invoke });
        if (unpriced[row.provider]) {
          await expect(call, unpriced[row.provider]).rejects.toMatchObject({ reason: "unpriced_model_under_hard_cap" });
          expect(invoke).not.toHaveBeenCalled();
          return;
        }
        await call;
        expect(invoke).toHaveBeenCalledOnce();
        expect(admission.acquire.mock.calls[0]?.[0].denialReason).toBeUndefined();
      });
    }
  }
});
