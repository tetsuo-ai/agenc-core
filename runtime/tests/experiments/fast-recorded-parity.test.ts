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

const fixtures = ["t016-recorded.json", "t017-recorded.json"].flatMap(name =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))) as {
  source: string; system: string; user: string; history: LLMMessage[]; responses: LLMResponse[]; toolResults: Record<string, string>;
}[];

for (const fixture of fixtures) test(`recorded ${fixture.source} with current alias semantics has byte-identical fast/normal request bodies`, async () => {
  // Keep the historical recordings immutable. Their unknown-Read receipts
  // predate aliases; project only those calls onto the current FileRead contract.
  // The live filesystem parity test separately proves actual alias execution.
  const projectedResults = { ...fixture.toolResults };
  const calls = fixture.responses.flatMap(response => response.toolCalls);
  const failedReadIds = new Set<string>();
  for (const call of calls.filter(call => call.name === "Read")) {
    const args = JSON.parse(call.arguments);
    const matchingRead = calls.find(candidate => {
      if (candidate.name !== "FileRead") return false;
      const other = JSON.parse(candidate.arguments);
      return other.file_path === args.file_path &&
        Number(other.offset ?? 1) === Number(args.offset ?? 1) &&
        Number(other.limit ?? 2000) === Number(args.limit ?? 2000);
    });
    if (matchingRead !== undefined) {
      projectedResults[call.id] = fixture.toolResults[matchingRead.id]!;
    } else {
      // This trace reads a missing examples path before retrying a boltons path.
      projectedResults[call.id] = `AGENC_DATA\nENOENT: no such file or directory, open '${args.file_path}'\nAGENC_DATA`;
      failedReadIds.add(call.id);
    }
  }
  const run = async (fast: boolean) => {
    const registry = buildToolRegistry({ workspaceRoot: "/workspace", lightMode: true, requireAdmission: false,
      sandboxExecutionBroker: explicitDangerBroker });
    for (const tool of registry.tools) {
      tool.execute = async args => {
        const callId = String(args.__callId);
        const content = projectedResults[callId];
        expect(content, `${tool.name} ${callId} must have recorded output`).toBeDefined();
        // Fixtures contain already projected wire text. Remove the compact
        // outer frame before replaying it as a raw tool result; the production
        // unframe helper recognizes the legacy verbose frame only.
        const raw = content.startsWith("AGENC_DATA\n") && content.endsWith("\nAGENC_DATA")
          ? content.slice("AGENC_DATA\n".length, -"\nAGENC_DATA".length) : content;
        return { content: String(unframeUntrustedToolResultContent(tool.name, raw)),
          ...(failedReadIds.has(callId) ? { isError: true } : {}) };
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
    Object.assign(session.config, { taskTokenBudget: 0 });
    Object.assign(session.services, { permissionModeRegistry: new PermissionModeRegistry({
      ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
    }) });
    const ctx = mkCtx({ cwd: "/workspace", permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
      modelInfo: { ...mkCtx().modelInfo, contextWindow: 1_048_576, maxOutputTokens: 8192 },
      // Replay the complete recorded trace; task-budget stopping has separate coverage.
      config: { ...mkCtx().config, taskTokenBudget: 0, bypassFastMode: fast } });
    await drain(runTurn(session, ctx, fixture.user, { systemPrompt: fixture.system, history: fixture.history,
      exactOutput: true }));
    expect(bodies).toHaveLength(fixture.responses.length);
    expect(fastCalls).toBe(fast ? fixture.responses.length : 0);
    for (const body of bodies) {
      for (const message of JSON.parse(body).messages) {
        if (message.role === "tool") {
          expect(message.content, `projected recorded output ${message.tool_call_id}`)
            .toBe(projectedResults[message.tool_call_id]);
        }
      }
    }
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
