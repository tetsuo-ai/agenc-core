/**
 * The standard (non-Light) fixed request prefix through the real turn loop,
 * for a session with compact tool wording (the default standard deferral):
 * what every request carries, what is said once in a cache-safe place, and
 * that every safety rule the cut parts carried is still in front of the model.
 */
import { describe, expect, test } from "vitest";
import type { LLMChatOptions, LLMMessage, LLMResponse } from "../../src/llm/types.js";
import type { PermissionMode } from "../../src/permissions/types.js";
import { assembleBaseInstructionsForModel } from "../../src/prompts/system-prompt.js";
import { COMPACT_BYPASS_AUTONOMY_NOTE } from "../../src/prompts/permissions-prompt.js";
import { AGENC_UNDO_GUIDANCE, AGENC_UNDO_PATHS } from "../../src/prompts/product-help.js";
import { MEMORY_RULES_MARKER } from "../../src/memory/memdir.js";
import { permissionInstructionsStateAutonomy } from "../../src/session/permission-instructions.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { UNTRUSTED_TOOL_RESULT_BOUNDARY } from "../../src/tools/untrusted-tool-result-framing.js";
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

/** One tool round, then a final answer, for every turn, in a standard session with compact tool wording. */
async function scriptedSession(mode: PermissionMode, contextOverrides: Record<string, unknown> = {}) {
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
    compactPresentation: true,
    tools: [{ name: "Probe", description: "Probe", inputSchema: { type: "object" }, execute: async () => ({ content: "probed" }) }],
    toLLMTools: () => [{ type: "function", function: { name: "Probe", description: "Probe", parameters: { type: "object" } } }],
    dispatch: async () => ({ content: "probed" }),
  } as unknown as ToolRegistry;
  const { session } = mkSession({
    provider,
    registry,
    services: { runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: false }) },
  });
  await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode });
  const context = {
    ...mkCtx({ permissionMode: mode, sandboxPolicy: { value: "workspace_write" }, ...contextOverrides } as never),
    permissionInstructionsDeferred: true,
  };
  const instructions = await assembleBaseInstructionsForModel({
    session, ctx: context, registry, provider: "deepseek",
    permissionContext: session.permissionModeRegistry.current(),
    profile: "standard",
  });
  const turn = async (subId: string, message: string) =>
    drain(runTurn(session, { ...context, subId, baseInstructions: instructions }, message));
  return { session, context, requests, turn };
}

describe("standard fixed request prefix", () => {
  test("bypass states its autonomy once in the permission text, with the auto-mode reminder's rules and no reminder", async () => {
    const standard = await scriptedSession("bypassPermissions");
    await standard.turn("turn-1", "Fix the failing test.");
    expect(standard.requests).toHaveLength(2);
    for (const request of standard.requests) {
      expect(request.systemPrompt).toContain(COMPACT_BYPASS_AUTONOMY_NOTE);
      expect(count(request, "Auto mode is active")).toBe(0);
      // What the reminder said that the head's action rules do not.
      expect(request.systemPrompt).toContain("never share a secret unless the user authorized that secret and its destination");
      expect(request.systemPrompt).toContain("else make reasonable assumptions");
      // The head keeps its action rules and the untrusted tool result policy.
      expect(request.systemPrompt).toContain("# Executing actions with care");
      expect(request.systemPrompt).toContain("Check with the user before actions that are hard to reverse");
      expect(request.systemPrompt).toContain(UNTRUSTED_TOOL_RESULT_BOUNDARY);
    }
    expect(permissionInstructionsStateAutonomy(
      standard.session, standard.context, standard.session.permissionModeRegistry.current(), "",
    )).toBe(true);
    // A mode whose permission text has no autonomy note keeps the reminder.
    const acceptEdits = await scriptedSession("acceptEdits");
    await acceptEdits.turn("turn-1", "Fix the failing test.");
    expect(acceptEdits.requests[0]!.systemPrompt).not.toContain(COMPACT_BYPASS_AUTONOMY_NOTE);
    expect(count(acceptEdits.requests[0]!, "## Auto Mode Active")).toBe(1);
  });

  test("with empty memory the standard rules and directories arrive once, with the first message about memory", async () => {
    const standard = await scriptedSession("bypassPermissions");
    await standard.turn("turn-1", "I'm new to this repo. What does it do, where does execution start, and how does data flow?");
    await standard.turn("turn-2", "Remember that I prefer tabs over spaces.");
    await standard.turn("turn-3", "Also note that down: we use pnpm here.");
    const requests = standard.requests;
    expect(requests).toHaveLength(6);
    for (let index = 1; index < requests.length; index += 1) {
      expect(requests[index]!.systemPrompt).toBe(requests[index - 1]!.systemPrompt);
      expect(requests[index]!.messages.slice(0, requests[index - 1]!.messages.length)).toEqual(requests[index - 1]!.messages);
    }
    // The fixed prefix carries no memory rules or directories, and the explain request brings none.
    expect(requests[0]!.systemPrompt).not.toContain(MEMORY_RULES_MARKER);
    expect(requests[0]!.systemPrompt).not.toContain("# Memory directories");
    for (const request of requests.slice(0, 2)) expect(count(request, MEMORY_RULES_MARKER)).toBe(0);
    // The memory request brings them once, right before the message, with the paths.
    const asked = requests[2]!;
    const index = asked.messages.findIndex((message) => text(message).includes(MEMORY_RULES_MARKER));
    expect(index).toBeGreaterThan(0);
    expect(text(asked.messages[index]!)).toContain("# Memory directories");
    expect(text(asked.messages[index + 1]!)).toContain("Remember that I prefer tabs over spaces.");
    for (const request of requests.slice(2)) expect(count(request, MEMORY_RULES_MARKER)).toBe(1);
  });

  test("the compact head of local tool providers carries no memory rules and gets none on request", async () => {
    const compact = await scriptedSession("bypassPermissions", { modelProviderId: "ollama" });
    await compact.turn("turn-1", "Remember that I prefer tabs over spaces.");
    for (const request of compact.requests) {
      expect(request.systemPrompt).not.toContain(MEMORY_RULES_MARKER);
      expect(count(request, MEMORY_RULES_MARKER)).toBe(0);
    }
  });

  test("an undo question gets the paths once; the head only says to answer it without tools", async () => {
    const standard = await scriptedSession("bypassPermissions");
    await standard.turn("turn-1", "Fix the failing test.");
    await standard.turn("turn-2", "How do I undo what you just did?");
    const requests = standard.requests;
    expect(requests[0]!.systemPrompt).toContain(AGENC_UNDO_GUIDANCE);
    expect(requests[0]!.systemPrompt).not.toContain("/rewind");
    for (const request of requests.slice(0, 2)) expect(count(request, AGENC_UNDO_PATHS)).toBe(0);
    const asked = requests[2]!;
    const reminderIndex = asked.messages.findIndex((message) => text(message).includes(AGENC_UNDO_PATHS));
    expect(reminderIndex).toBeGreaterThan(0);
    expect(text(asked.messages[reminderIndex + 1]!)).toContain("How do I undo what you just did?");
    for (const request of requests.slice(2)) expect(count(request, AGENC_UNDO_PATHS)).toBe(1);
  });
});
