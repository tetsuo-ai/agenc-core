import { afterEach, expect, test, vi } from "vitest";
import type { AgenCConfig } from "../../src/config/schema.js";
import { assembleSystemPrompt } from "../../src/prompts/system-prompt.js";
import { buildProviderOptions } from "../../src/phases/stream-model.js";
import { buildSamplingRequestContract } from "../../src/session/run-turn-sampling-request.js";
import type { TurnState } from "../../src/session/turn-state.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { createTestConfigStore, mkCtx, mkSession } from "../fixtures.js";

afterEach(() => vi.restoreAllMocks());

test.each([
  { provider: "openai", lightMode: true },
  { provider: "anthropic", lightMode: true },
  { provider: "grok", lightMode: true },
  { provider: "openrouter", lightMode: true },
  { provider: "openai-compatible", lightMode: true },
  { provider: "agenc", lightMode: true },
  { provider: "deepseek", lightMode: false },
  { provider: "deepseek", lightMode: true, simpleMode: true },
])("lean config leaves excluded sessions byte-identical: %j", async selection => {
  for (const depth of [0, 1]) {
    // Keep the same home authority so OpenAI's cache scope also compares byte for byte.
    const configStore = createTestConfigStore();
    const capture = async (light_request: "full" | "lean") => {
      const config: AgenCConfig = { light_request, light_request_options: { process_tools: false } };
      vi.spyOn(configStore, "current").mockReturnValue(config);
      const { session } = mkSession({ services: {
        configStore,
        runtimeOptions: { lightMode: selection.lightMode, simpleMode: "simpleMode" in selection && selection.simpleMode } as never,
        providerEnvironment: {},
      } });
      Object.assign(session.services.provider, { name: selection.provider });
      const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: selection.lightMode, getSession: () => session });
      Object.assign(session.services, { registry });
      const ctx = mkCtx({ depth, currentDate: "2026-11-13", modelProviderId: selection.provider, permissionInstructionsDeferred: true });
      const prompt = await assembleSystemPrompt({ session, ctx, provider: selection.provider, deferPermissionInstructions: true,
        promptIdentity: { provider: selection.provider, model: ctx.modelInfo.slug } });
      // Include resumed/system-shaped history and a runtime reminder, not only an empty first turn.
      const state = { modelInstructions: prompt.text, messagesForQuery: [
        { role: "system", content: "Recorded historical summary." },
        { role: "user", content: "Automatic reminder.", runtimeOnly: { attachmentKind: "auto_mode" } },
        { role: "user", content: "Continue the review." },
      ] } as TurnState;
      const request = buildSamplingRequestContract(state, session, ctx, undefined, true);
      return JSON.stringify({ request, options: buildProviderOptions(request, ctx, new AbortController().signal, session) });
    };
    expect(await capture("lean")).toBe(await capture("full"));
  }
});
