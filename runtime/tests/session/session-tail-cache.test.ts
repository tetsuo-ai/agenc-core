import { describe, expect, test } from "vitest";
import type { LLMChatOptions } from "../../src/llm/types.js";
import { assembleBaseInstructionsForModel } from "../../src/prompts/system-prompt.js";
import { SYSTEM_PROMPT_VOLATILE_BOUNDARY } from "../../src/prompts/system-prompt-boundary.js";
import { runTurn } from "../../src/session/run-turn.js";
import { CACHE_SESSION_TAIL_ENV } from "../../src/session/session-tail-cache.js";
import {
  getSelectedProviderEnvironment,
  runWithStartupProviderSelection,
} from "../../src/utils/model/providers.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

async function systemPromptsForTwoTurns(
  providerId: string,
  env: Record<string, string>,
): Promise<string[]> {
  const provider = mkProvider();
  const prompts: string[] = [];
  provider.chatStream = async (_messages, _onChunk, options?: LLMChatOptions) => {
    prompts.push(options?.systemPrompt ?? "");
    return {
      content: "Done.",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test-model",
      finishReason: "stop",
    };
  };
  const { session } = mkSession({ provider, services: { providerEnvironment: env } });
  const context = { ...mkCtx({ modelProviderId: providerId }), permissionInstructionsDeferred: true };
  const baseInstructions = await assembleBaseInstructionsForModel({
    session, ctx: context, registry: session.services.registry, provider: providerId,
    permissionContext: session.permissionModeRegistry.current(), profile: "standard",
  });
  await drain(runTurn(session, { ...context, baseInstructions }, "First task."));
  await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "acceptEdits" });
  await drain(runTurn(session, { ...context, subId: "turn-2", baseInstructions }, "Second task."));
  return prompts;
}

describe("session-tail caching in the request builder", () => {
  test("keeps the session-fixed prompt identical across turns and the permission section after the marker", async () => {
    const prompts = await systemPromptsForTwoTurns("grok", { [CACHE_SESSION_TAIL_ENV]: "1" });
    expect(prompts).toHaveLength(2);
    const [first, second] = prompts.map((prompt) => {
      const index = prompt.indexOf(SYSTEM_PROMPT_VOLATILE_BOUNDARY);
      expect(index).toBeGreaterThan(0);
      return { stable: prompt.slice(0, index), volatile: prompt.slice(index) };
    });
    expect(first!.stable).toContain("# Environment");
    expect(first!.stable).not.toContain("# Permission Mode");
    expect(second!.stable).toBe(first!.stable);
    expect(first!.volatile).toContain("# Permission Mode");
    expect(second!.volatile).toContain("# Permission Mode: acceptEdits");
    expect(second!.volatile).not.toBe(first!.volatile);
  });

  test("is on by default for Grok", async () => {
    const prompts = await systemPromptsForTwoTurns("grok", {});
    for (const prompt of prompts) {
      expect(prompt).toContain(SYSTEM_PROMPT_VOLATILE_BOUNDARY);
    }
  });

  test("leaves the prompt unchanged when the switch is off or the wire sends one block", async () => {
    for (const [providerId, env] of [
      ["grok", { [CACHE_SESSION_TAIL_ENV]: "0" }],
      ["openai", {}],
      ["deepseek", { [CACHE_SESSION_TAIL_ENV]: "1" }],
    ] as const) {
      const prompts = await systemPromptsForTwoTurns(providerId, env);
      for (const prompt of prompts) {
        expect(prompt).not.toContain(SYSTEM_PROMPT_VOLATILE_BOUNDARY);
        expect(prompt).toContain("# Permission Mode");
      }
    }
  });

  test("the session switch reaches the request builder through the captured session environment", async () => {
    // runWithStartupProviderSelection captures the environment through the
    // daemon client allowlist, as a daemon-owned (Desktop) session does, so a
    // switch missing from AGENC_DAEMON_CLIENT_ENV_KEYS would be dropped here.
    const cached = async (provider: string, model: string, environment: Record<string, string>) => {
      const prompts = await runWithStartupProviderSelection(
        { provider, model, environment },
        () => systemPromptsForTwoTurns(provider, { ...getSelectedProviderEnvironment() }),
      );
      expect(prompts).toHaveLength(2);
      return prompts.every((prompt) => prompt.includes(SYSTEM_PROMPT_VOLATILE_BOUNDARY));
    };
    expect(await cached("grok", "grok-4.6", {})).toBe(true);
    expect(await cached("grok", "grok-4.6", { [CACHE_SESSION_TAIL_ENV]: "0" })).toBe(false);
    expect(await cached("openai", "gpt-6", {})).toBe(false);
    expect(await cached("openai", "gpt-6", { [CACHE_SESSION_TAIL_ENV]: "1" })).toBe(true);
  });
});
