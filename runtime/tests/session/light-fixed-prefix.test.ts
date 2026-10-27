/**
 * Light's fixed request prefix through the real turn loop: what every request
 * carries, what is said once in a cache-safe place, and that the bytes the
 * provider already saw keep their place in every later request.
 */
import { describe, expect, test } from "vitest";
import type { LLMChatOptions, LLMMessage, LLMResponse } from "../../src/llm/types.js";
import type { PermissionMode } from "../../src/permissions/types.js";
import { assembleBaseInstructionsForModel } from "../../src/prompts/system-prompt.js";
import { LIGHT_BYPASS_AUTONOMY_NOTE } from "../../src/prompts/permissions-prompt.js";
import { AGENC_INSTRUCTION_FILE, AGENC_UNDO_PATHS, LIGHT_LOADED_INSTRUCTIONS_NOTE } from "../../src/prompts/product-help.js";
import { LIGHT_MEMORY_RULES_MARKER } from "../../src/memory/memdir.js";
import { permissionInstructionsStateAutonomy } from "../../src/session/permission-instructions.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

interface RecordedRequest {
  readonly messages: LLMMessage[];
  readonly systemPrompt: string;
}

function text(message: LLMMessage): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

function count(request: RecordedRequest, needle: string): number {
  return request.messages.filter((message) => text(message).includes(needle)).length;
}

/** One tool round, then a final answer, for every turn. */
async function scriptedSession(mode: PermissionMode, light: boolean, extraInstructions = "") {
  const requests: RecordedRequest[] = [];
  const provider = mkProvider();
  let step = 0;
  provider.chatStream = async (messages: LLMMessage[], _onChunk: unknown, options?: LLMChatOptions): Promise<LLMResponse> => {
    requests.push({ messages: structuredClone(messages), systemPrompt: options?.systemPrompt ?? "" });
    const callTool = step % 2 === 0;
    step += 1;
    return {
      content: callTool ? "" : "Done.",
      toolCalls: callTool ? [{ id: `read-${step}`, name: "Probe", arguments: "{}" }] : [],
      usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
      model: "test-model",
      finishReason: callTool ? "tool_calls" : "stop",
    };
  };
  const registry = {
    tools: [{ name: "Probe", description: "Probe", inputSchema: { type: "object" }, execute: async () => ({ content: "probed" }) }],
    toLLMTools: () => [{ type: "function", function: { name: "Probe", description: "Probe", parameters: { type: "object" } } }],
    dispatch: async () => ({ content: "probed" }),
  } as unknown as ToolRegistry;
  const { session } = mkSession({
    provider,
    registry,
    services: { runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: light }) },
  });
  await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode });
  const context = {
    ...mkCtx({ permissionMode: mode, sandboxPolicy: { value: "workspace_write" } } as never),
    permissionInstructionsDeferred: true,
  };
  const baseInstructions = await assembleBaseInstructionsForModel({
    session, ctx: context, registry, provider: "deepseek",
    permissionContext: session.permissionModeRegistry.current(),
    profile: light ? "light" : "standard",
  });
  const instructions = [extraInstructions, baseInstructions].filter(part => part.length > 0).join("\n\n");
  const turn = async (subId: string, message: string) =>
    drain(runTurn(session, { ...context, subId, baseInstructions: instructions }, message));
  return { session, context, requests, turn };
}

describe("Light fixed request prefix", () => {
  test("bypass mode states its autonomy once, in the permission text, with no auto-mode reminder", async () => {
    const light = await scriptedSession("bypassPermissions", true);
    await light.turn("turn-1", "Fix the failing test.");
    expect(light.requests).toHaveLength(2);
    for (const request of light.requests) {
      expect(request.systemPrompt).toContain(LIGHT_BYPASS_AUTONOMY_NOTE);
      expect(count(request, "Auto mode is active")).toBe(0);
    }
    expect(permissionInstructionsStateAutonomy(
      light.session, light.context, light.session.permissionModeRegistry.current(), "",
    )).toBe(true);

    // Modes whose permission text has no autonomy note keep the Light pulse.
    const acceptEdits = await scriptedSession("acceptEdits", true);
    await acceptEdits.turn("turn-1", "Fix the failing test.");
    expect(acceptEdits.requests[0]!.systemPrompt).not.toContain(LIGHT_BYPASS_AUTONOMY_NOTE);
    expect(count(acceptEdits.requests[0]!, "Auto mode is active: work autonomously")).toBe(1);

    // Standard sessions keep their full reminder.
    const standard = await scriptedSession("bypassPermissions", false);
    await standard.turn("turn-1", "Fix the failing test.");
    expect(count(standard.requests[0]!, "## Auto Mode Active")).toBe(1);
    expect(permissionInstructionsStateAutonomy(
      standard.session, standard.context, standard.session.permissionModeRegistry.current(), "",
    )).toBe(false);
  });

  test("every request extends the previous one byte for byte; an undo question adds the paths once", async () => {
    const light = await scriptedSession("bypassPermissions", true);
    await light.turn("turn-1", "Fix the failing test.");
    await light.turn("turn-2", "How do I undo what you just did?");
    await light.turn("turn-3", "Thanks. Now add a test for the empty case.");
    const requests = light.requests;
    expect(requests).toHaveLength(6);
    for (let index = 1; index < requests.length; index += 1) {
      const previous = requests[index - 1]!;
      const current = requests[index]!;
      // The fixed prefix (system prompt) never changes and the earlier messages
      // are an exact prefix of the later request: the provider cache holds.
      expect(current.systemPrompt).toBe(previous.systemPrompt);
      expect(current.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
    }
    // The first turn carries no undo text anywhere.
    for (const request of requests.slice(0, 2)) {
      expect(request.systemPrompt).not.toContain("/rewind");
      expect(count(request, AGENC_UNDO_PATHS)).toBe(0);
    }
    // The undo question gets the paths once, right before the question, and
    // they stay in place through the rest of the session.
    const asked = requests[2]!;
    const reminderIndex = asked.messages.findIndex((message) => text(message).includes(AGENC_UNDO_PATHS));
    expect(reminderIndex).toBeGreaterThan(0);
    expect(text(asked.messages[reminderIndex + 1]!)).toContain("How do I undo what you just did?");
    for (const request of requests.slice(2)) expect(count(request, AGENC_UNDO_PATHS)).toBe(1);
  });

  test("a question about instruction files says none is loaded, unless loaded files already say where they are", async () => {
    const question = "What does AGENC.md say about tests?";
    const none = await scriptedSession("bypassPermissions", true);
    await none.turn("turn-1", question);
    expect(count(none.requests[0]!, AGENC_INSTRUCTION_FILE)).toBe(1);
    // Loaded instruction files ride the instructions with their own note.
    const loaded = await scriptedSession("bypassPermissions", true,
      `<workspace_instructions trust="untrusted" authority="guidance_only">\n\nGuidance. ${LIGHT_LOADED_INSTRUCTIONS_NOTE}\n\nRun npm test.\n\n</workspace_instructions>`);
    await loaded.turn("turn-1", question);
    expect(loaded.requests[0]!.systemPrompt).toContain(LIGHT_LOADED_INSTRUCTIONS_NOTE);
    for (const request of loaded.requests) expect(count(request, AGENC_INSTRUCTION_FILE)).toBe(0);
  });

  test("with empty memory the rules and directories arrive once, with the first message about memory", async () => {
    const light = await scriptedSession("bypassPermissions", true);
    await light.turn("turn-1", "Fix the failing test.");
    await light.turn("turn-2", "Remember that I prefer tabs over spaces.");
    await light.turn("turn-3", "Also note that down: we use pnpm here.");
    const requests = light.requests;
    expect(requests).toHaveLength(6);
    for (let index = 1; index < requests.length; index += 1) {
      expect(requests[index]!.systemPrompt).toBe(requests[index - 1]!.systemPrompt);
      expect(requests[index]!.messages.slice(0, requests[index - 1]!.messages.length)).toEqual(requests[index - 1]!.messages);
    }
    // The fixed prefix carries no memory rules or directories.
    expect(requests[0]!.systemPrompt).not.toContain(LIGHT_MEMORY_RULES_MARKER);
    expect(requests[0]!.systemPrompt).not.toContain("# Memory directories");
    for (const request of requests.slice(0, 2)) expect(count(request, LIGHT_MEMORY_RULES_MARKER)).toBe(0);
    // The memory request brings them once, right before the message, with the paths.
    const asked = requests[2]!;
    const index = asked.messages.findIndex((message) => text(message).includes(LIGHT_MEMORY_RULES_MARKER));
    expect(index).toBeGreaterThan(0);
    expect(text(asked.messages[index]!)).toContain("# Memory directories");
    expect(text(asked.messages[index + 1]!)).toContain("Remember that I prefer tabs over spaces.");
    for (const request of requests.slice(2)) expect(count(request, LIGHT_MEMORY_RULES_MARKER)).toBe(1);
  });
});
