import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/desktop-goal-providers.js";
import { mergeDaemonClientEnvironment } from "../../src/app-server/client-env-snapshot.js";
import { requireProviderRuntimeCredential, resolveProviderRuntimeAuthority } from "../../src/llm/provider-options.js";
import { resolveReasoningEffort } from "../../src/llm/reasoning-effort.js";
import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { createAllowAdmissionHarness } from "../budget/admission-test-harness.js";
import type { ProviderName, LLMProvider, LLMChatOptions } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";

// Dynamic catalogs need concrete fixture responses, not release exceptions.
const discovered = {
  agenc: { provider: "agenc", model: "openai/gpt-5", key: null, efforts: [] },
  venice: { provider: "openai-compatible", model: "venice-discovered-model", key: "OPENAI_COMPATIBLE_API_KEY", efforts: [] },
} as const;

describe("Desktop Goal provider, model and effort release admission gate", () => {
  it("enumerates every provider including discovered-model fixtures", () => {
    expect(fixture.rows).toHaveLength(25);
    expect(fixture.rows.map(row => row.provider)).toEqual(expect.arrayContaining(Object.keys(discovered)));
  });
  for (const row of [...fixture.rows, ...fixture.catalogRows]) {
    const selected = row.model === null || row.model === "agenc"
      ? discovered[row.provider as keyof typeof discovered] ?? row : row;
    for (const effort of row.efforts.length ? row.efforts : [undefined]) {
      it(`${row.provider} / ${row.model} / ${effort ?? "no effort dial"}`, async () => {
        const model = selected.model!;
        const providerName = selected.provider as ProviderName;
        const overrides = selected.key ? { [selected.key]: "test-current-credential", ...(row.provider === "venice" ? { OPENAI_COMPATIBLE_BASE_URL: "https://api.venice.ai/api/v1" } : {}) } : row.provider === "amazon-bedrock"
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
        await call;
        expect(invoke).toHaveBeenCalledOnce();
        expect(admission.acquire.mock.calls[0]?.[0].denialReason).toBeUndefined();
      });
    }
  }
});
