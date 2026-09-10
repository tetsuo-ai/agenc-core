import { afterEach, describe, expect, test, vi } from "vitest";

import type { LLMMessage, LLMTool } from "../../src/llm/types.js";
import type {
  CompactContext,
  RuntimeMessage,
} from "../../src/services/compact/types.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";

const summarizer = vi.hoisted(() => ({
  manualCompactCall: vi.fn(),
}));

// Replace only the provider-backed summarizer. Everything else on the manual
// /compact path stays real: history projection into runtime messages, the
// slash-command bookkeeping messages, post-compact message assembly, the
// projection back into LLM history, and the session history replacement.
vi.mock("../../src/services/compact/compact.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/services/compact/compact.js")
  >()),
  manualCompactCall: summarizer.manualCompactCall,
}));

import { compactCommand, contextCommand } from "../../src/commands/session-compact.js";
import * as systemPrompt from "../../src/prompts/system-prompt.js";
import * as permissionInstructions from "../../src/session/permission-instructions.js";
import * as outputStyles from "../../src/constants/outputStyles.js";

const TOOL_CALL_ID = "toolu_compact_1792";
const TOOL_ARGUMENTS = JSON.stringify({ command: "pwd" });
const TOOL_RESULT = "/tmp/project\n";

function commandContext(session: unknown, argsRaw = "") {
  return {
    session,
    argsRaw,
    cwd: "/tmp/project",
    home: "/tmp",
    agencHome: "/tmp/.agenc",
  } as never;
}

/**
 * Stand-in for the compaction summarizer: keep the two most recent runtime
 * messages exactly as they were handed in, the way the real summarizer keeps
 * its recent tail, and summarize everything before them.
 */
function keepRecentTail(
  _args: string,
  context: CompactContext & { readonly messages?: RuntimeMessage[] },
) {
  const messages = context.messages ?? [];
  return Promise.resolve({
    type: "compact" as const,
    displayText: "Conversation compacted (test summarizer)",
    compactionResult: {
      boundaryMarker: { role: "user" as const, content: "compaction boundary" },
      summaryMessages: [
        { role: "user" as const, content: "Summary of the earlier turns." },
      ],
      messagesToKeep: messages.slice(-2),
      attachments: [],
    },
  });
}

function expectEveryToolResultToFollowItsCall(messages: readonly LLMMessage[]): void {
  const toolResults = messages.filter((message) => message.role === "tool");
  expect(toolResults.length).toBeGreaterThan(0);
  for (const result of toolResults) {
    const producer = messages[messages.indexOf(result) - 1];
    expect(producer?.role).toBe("assistant");
    expect(producer?.toolCalls?.map((call) => call.id)).toContain(result.toolCallId);
  }
}

describe("/compact keeps retained assistant tool calls", () => {
  afterEach(() => {
    summarizer.manualCompactCall.mockReset();
    vi.restoreAllMocks();
  });

  test("context display composes the same deferred permission section from current authority", async () => {
    const { session } = mkSession();
    await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "acceptEdits" });
    vi.spyOn(session, "newDefaultTurnWithSubId").mockReturnValue(mkCtx({
      baseInstructions: "STABLE_BASE",
      permissionInstructionsDeferred: true,
      permissionMode: "plan",
      modelProviderId: "grok",
    }));
    const assemble = vi.spyOn(systemPrompt, "assembleSystemPrompt");
    vi.spyOn(outputStyles, "getOutputStyleConfig").mockResolvedValue(null);
    const permission = vi.spyOn(permissionInstructions, "getSessionPermissionInstructions");

    const result = await contextCommand.execute({ ...commandContext(session), env: {}, providerEnvironment: {} } as never);
    expect(result).toMatchObject({ kind: "text" });

    expect(assemble).toHaveBeenCalledWith(expect.objectContaining({ deferPermissionInstructions: true, permissionContext: expect.objectContaining({ mode: "acceptEdits" }) }));
    expect(permission).toHaveBeenCalledTimes(2);
    for (const result of permission.mock.results) {
      expect(result.value).toContain("# Permission Mode: acceptEdits");
      expect(result.value).not.toContain("# Permission Mode: plan");
    }
  });

  test("manual compaction includes current permission guidance instead of the stale turn mode", async () => {
    summarizer.manualCompactCall.mockImplementation(keepRecentTail);
    const { session } = mkSession({ history: [{ role: "user", content: "First request." }, { role: "assistant", content: "First answer." }] });
    await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "acceptEdits" });
    vi.spyOn(session, "newDefaultTurnWithSubId").mockReturnValue(mkCtx({
      baseInstructions: "STABLE_BASE",
      permissionInstructionsDeferred: true,
      permissionMode: "plan",
      modelProviderId: "grok",
    }));

    const result = await compactCommand.execute(commandContext(session));

    expect(result).toMatchObject({ kind: "compact" });
    const systemPrompt = summarizer.manualCompactCall.mock.calls[0]?.[1]?.options?.systemPrompt;
    expect(systemPrompt).toContain("STABLE_BASE");
    expect(systemPrompt).toContain("# Permission Mode: acceptEdits");
    expect(systemPrompt).not.toContain("# Permission Mode: plan");
  });

  test.each(["ollama", "grok", "lmstudio"])(
    "accounts for the %s sampling catalog without runtime tool wrappers",
    async (providerName) => {
      summarizer.manualCompactCall.mockImplementation(keepRecentTail);
      const tools: LLMTool[] = ["FileRead", "Write", "remote_tool"].map(
        (name) => ({
          type: "function",
          function: {
            name,
            description: `${name} description`,
            parameters: { type: "object", properties: {} },
          },
        }),
      );
      const { session } = mkSession({
        history: [
          { role: "user", content: "first request" },
          { role: "assistant", content: "first answer" },
        ],
      });
      vi.spyOn(session.services.registry, "toLLMTools").mockReturnValue(tools);
      vi.spyOn(session, "newDefaultTurnWithSubId").mockReturnValue(mkCtx({
        modelProviderId: providerName,
        dynamicTools: [{ name: "Write", deferLoading: true }] as never,
        baseInstructions: "base instructions",
      }));

      const result = await compactCommand.execute(commandContext(session));

      expect(result).toMatchObject({ kind: "compact" });
      expect(summarizer.manualCompactCall).toHaveBeenCalledTimes(1);
      const compactContext = summarizer.manualCompactCall.mock.calls[0]?.[1];
      const expectedNames = providerName === "lmstudio"
        ? ["FileRead"]
        : ["FileRead", "remote_tool"];
      expect(compactContext?.options?.tools).toEqual(
        tools.filter((tool) => expectedNames.includes(tool.function.name)),
      );
      expect(compactContext?.options?.systemPrompt).toBe("base instructions");
    },
  );

  test("a retained assistant tool call and its result survive manual compaction with the arguments intact", async () => {
    summarizer.manualCompactCall.mockImplementation(keepRecentTail);
    const { session, state } = mkSession({
      provider: mkProvider({ content: "unused by the mocked summarizer" }),
      modelInfo: { contextWindow: 131_072 },
      history: [
        { role: "user", content: "first request" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "Where are we?" },
        {
          role: "assistant",
          content: "Checking the working directory.",
          toolCalls: [
            { id: TOOL_CALL_ID, name: "Bash", arguments: TOOL_ARGUMENTS },
          ],
        },
        {
          role: "tool",
          toolCallId: TOOL_CALL_ID,
          toolName: "Bash",
          content: TOOL_RESULT,
        },
      ],
    });

    const result = await compactCommand.execute(commandContext(session));

    expect(result).toMatchObject({ kind: "compact" });
    expect(summarizer.manualCompactCall).toHaveBeenCalledTimes(1);

    const history = session.snapshotHistoryMessages();
    const assistantIndex = history.findIndex(
      (message) => message.role === "assistant",
    );
    expect(assistantIndex).toBeGreaterThan(-1);
    expect(history[assistantIndex]).toEqual({
      role: "assistant",
      content: "Checking the working directory.",
      toolCalls: [{ id: TOOL_CALL_ID, name: "Bash", arguments: TOOL_ARGUMENTS }],
    });
    expect(history[assistantIndex + 1]).toMatchObject({
      role: "tool",
      toolCallId: TOOL_CALL_ID,
      toolName: "Bash",
      content: TOOL_RESULT,
    });
    expectEveryToolResultToFollowItsCall(history);
    expect(state.history[assistantIndex]?.toolCalls).toEqual([
      { id: TOOL_CALL_ID, name: "Bash", arguments: TOOL_ARGUMENTS },
    ]);
    expect(JSON.stringify(history)).not.toContain("first request");
  });
});
