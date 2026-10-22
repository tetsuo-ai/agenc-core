import { expect, test, vi } from "vitest";
import type { LLMChatOptions, LLMMessage } from "../../src/llm/types.js";
import { assembleBaseInstructionsForModel } from "../../src/prompts/system-prompt.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { SessionProviderService } from "../../src/session/provider-service.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { createTestConfigStore, drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

vi.mock("node:crypto", async importOriginal => ({
  ...await importOriginal<typeof import("node:crypto")>(),
  randomUUID: () => "00000000-0000-4000-8000-000000000001",
}));

const tuning = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../src/tools/light-profile.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/tools/light-profile.js")>();
  const { modelFamilyFor } = await import("../../src/llm/model-family.js");
  return {
    ...actual,
    lightUsesGlmTuning: (provider?: string, model?: string) => tuning.enabled && actual.lightUsesGlmTuning(provider, model),
    // Before this change only DeepSeek models used batch Edit. Disabling the
    // tuning here reconstructs that routing without a production env switch.
    lightUsesBatchEdit: (provider?: string, model?: string) => tuning.enabled
      ? actual.lightUsesBatchEdit(provider, model)
      : modelFamilyFor(provider, model) === "deepseek",
  };
});

async function firstRequest(providerName: string, model: string, enabled: boolean, configStore: ReturnType<typeof createTestConfigStore>) {
  tuning.enabled = enabled;
  const requests: string[] = [];
  const provider = mkProvider();
  Object.assign(provider, { name: providerName });
  provider.chatStream = async (messages: LLMMessage[], _onChunk: unknown, options?: LLMChatOptions) => {
    // runtimeOnly is internal history metadata, never sent to the model.
    requests.push(JSON.stringify({ messages, options }, (key, value) => key === "runtimeOnly" ? undefined : value));
    return { content: "Done.", toolCalls: [], model, finishReason: "stop" as const,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  };
  const { session } = mkSession({ provider, model, services: {
    configStore,
    runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true }),
    providerService: new SessionProviderService({
      initialProvider: provider, initialProviderName: providerName, initialModel: model,
      environment: {}, sessionId: "glm-parity",
    }),
  } });
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session });
  Object.assign(session.services, { registry });
  const ctx = mkCtx({ modelInfo: session.modelInfo, collaborationMode: { model } } as never);
  const baseInstructions = await assembleBaseInstructionsForModel({
    session, ctx, registry, provider: providerName, promptIdentity: { provider: providerName, model },
    permissionContext: session.permissionModeRegistry.current(), profile: "light",
  });
  await drain(runTurn(session, { ...ctx, baseInstructions }, "Fix the failing test."));
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

test.each([
  ["deepseek", "deepseek-v4-pro", false],
  ["deepseek", "deepseek-flash", false],
  ["openai", "gpt-6-luna", false],
  ["abliteration", "abliterated-model-large", false],
  ["openrouter", "z-ai/glm-5.3", false],
  ["abliteration", "abliterated-model-large-v2", true],
] as const)("first Light request parity: %s %s (changes=%s)", async (provider, model, changes) => {
  const configStore = createTestConfigStore();
  const before = await firstRequest(provider, model, false, configStore);
  const after = await firstRequest(provider, model, true, configStore);
  if (changes) expect(after).not.toBe(before);
  else expect(after).toBe(before);
});
