import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { buildChatCompletionsRequest } from "../../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../src/llm/wire/capability-gating.js";
import { runTurn } from "../../src/session/run-turn.js";
import { oneShotFastModeActive } from "../../src/one-shot-fast-mode.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { unframeUntrustedToolResultContent } from "../../src/tools/untrusted-tool-result-framing.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/t016-recorded.json", import.meta.url), "utf8")) as {
  source: string; system: string; user: string; history: LLMMessage[]; responses: LLMResponse[]; toolResults: Record<string, string>;
}[];

for (const fixture of fixtures) test(`recorded ${fixture.source} has byte-identical fast/normal request bodies`, async () => {
  const run = async (fast: boolean) => {
    const registry = buildToolRegistry({ workspaceRoot: "/workspace", lightMode: true, requireAdmission: false,
      sandboxExecutionBroker: explicitDangerBroker });
    for (const tool of registry.tools) {
      tool.execute = async args => {
        const callId = String(args.__callId);
        const content = fixture.toolResults[callId];
        expect(content, `${tool.name} ${callId} must have recorded output`).toBeDefined();
        return { content: String(unframeUntrustedToolResultContent(tool.name, content)) };
      };
    }
    const provider = { ...mkProvider(), name: "deepseek" };
    const bodies: string[] = [];
    let fastCalls = 0;
    provider.chatStream = async (messages, _delta, options) => {
      if (oneShotFastModeActive()) fastCalls++;
      bodies.push(JSON.stringify(buildChatCompletionsRequest({ model: "deepseek-flash", messages,
        tools: options?.tools ?? [], options,
        providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("deepseek", "deepseek-flash") })));
      const response = fixture.responses[bodies.length - 1];
      expect(response, "replay must not request an extra model response").toBeDefined();
      return structuredClone(response!);
    };
    const { session } = mkSession({ cwd: "/workspace", provider, registry, model: "deepseek-flash", services: {
      sandboxExecutionBroker: explicitDangerBroker,
      runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true,
        dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true }),
    } });
    Object.assign(session.services, { permissionModeRegistry: new PermissionModeRegistry({
      ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
    }) });
    const ctx = mkCtx({ cwd: "/workspace", permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
      modelInfo: { ...mkCtx().modelInfo, contextWindow: 1_048_576, maxOutputTokens: 8192 },
      config: { ...mkCtx().config, bypassFastMode: fast } });
    await drain(runTurn(session, ctx, fixture.user, { systemPrompt: fixture.system, history: fixture.history,
      exactOutput: true }));
    expect(bodies).toHaveLength(fixture.responses.length);
    expect(fastCalls).toBe(fast ? fixture.responses.length : 0);
    const secondRequest = JSON.parse(bodies[1]!);
    expect(secondRequest.messages.find((message: { role: string }) => message.role === "assistant")
      .reasoning_content).toBe(fixture.responses[0]!.providerReasoningContent);
    return bodies;
  };
  const normal = await run(false);
  const fast = await run(true);
  for (let i = 0; i < normal.length; i++) {
    expect(JSON.parse(fast[i]!), `request ${i + 1}`).toEqual(JSON.parse(normal[i]!));
    expect(fast[i], `request ${i + 1} serialized bytes`).toBe(normal[i]);
  }
});
