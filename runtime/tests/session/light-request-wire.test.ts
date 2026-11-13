import { expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import type { AgenCConfig } from "../../src/config/schema.js";
import { buildProviderOptions } from "../../src/phases/stream-model.js";
import { assembleSystemPrompt } from "../../src/prompts/system-prompt.js";
import { attachmentsToMessages } from "../../src/prompts/attachments/messages.js";
import { buildSamplingRequestContract } from "../../src/session/run-turn-sampling-request.js";
import type { TurnState } from "../../src/session/turn-state.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { frameUntrustedToolResultContent } from "../../src/tools/untrusted-tool-result-framing.js";
import { createTestConfigStore, mkCtx, mkSession } from "../fixtures.js";
import { createSuccessfulChatResponse } from "../llm/providers/openai-compatible-test-helpers.js";

vi.mock("../../src/utils/resource-limits.js", () => ({ resourceLimitsLine: () => null }));

export async function captureLightRequest(mode: "full" | "lean", nonInteractive: boolean, options: AgenCConfig["light_request_options"] = {}) {
  let body = "";
  const model = "deepseek-flash";
  const provider = new DeepSeekProvider({ apiKey: "test-only", model,
    fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
      body = String(init?.body);
      return createSuccessfulChatResponse("lean-fixture")(model, "Done.");
    }),
  });
  const { session } = mkSession({ provider, model, services: {
    runtimeOptions: { lightMode: true, nonInteractive } as never,
    configStore: createTestConfigStore({ base: { light_request: mode, light_request_options: options } }),
    providerEnvironment: {},
  } });
  const registry = buildToolRegistry({ workspaceRoot: "/workspace", lightMode: true, getSession: () => session });
  Object.assign(session.services, { registry });
  const ctx = mkCtx({ cwd: "/workspace", currentDate: "2026-11-13", modelProviderId: "deepseek",
    modelInfo: { ...session.modelInfo, slug: model, supportedReasoningLevels: ["low", "high", "max"] },
    permissionInstructionsDeferred: true,
  });
  const prompt = await assembleSystemPrompt({ session, ctx, provider: "deepseek", lightProfile: true,
    promptIdentity: { provider: "deepseek", model }, deferPermissionInstructions: true,
    enabledToolNames: new Set(registry.toLLMTools().map(tool => tool.function.name)),
    projectInstructions: '<workspace_instructions trust="untrusted" authority="guidance_only">Use the project formatter.</workspace_instructions>',
  });
  const state = { modelInstructions: prompt.text, messagesForQuery: [
    ...attachmentsToMessages([{ kind: "auto_mode", variant: "full" }]),
    { role: "user", content: "Fix the failing test." },
    { role: "assistant", content: "", toolCalls: [{ id: "exec-1", name: "exec_command", arguments: '{"cmd":"npm test"}' }] },
    { role: "tool", toolCallId: "exec-1", toolName: "exec_command",
      content: frameUntrustedToolResultContent("exec_command", "1 test failed\n\n\n[exec exit_code=1 wall_time=1.2500s tokens=4]", "workspace", true) },
  ] } as TurnState;
  const request = buildSamplingRequestContract(state, session, ctx);
  await provider.chat([...request.input], buildProviderOptions(request, ctx, new AbortController().signal, session));
  return body;
}

test.each([false, true])("full native DeepSeek HTTP bytes, headless=%s", async nonInteractive => {
  // Captured before the lean request implementation. Do not update with lean fixtures.
  expect(await captureLightRequest("full", nonInteractive)).toMatchSnapshot();
});
