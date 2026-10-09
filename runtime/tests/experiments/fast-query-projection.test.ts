import { afterEach, expect, test, vi } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { withOneShotFastMode } from "../../src/one-shot-fast-mode.js";
import { prepareAgenCQueryMessages } from "../../src/session/run-turn-query-messages.js";
import { fromAgenCRuntimeMessages, toAgenCRuntimeMessages, projectUncompactedLlmMessages } from "../../src/session/runtime-message-conversion.js";
import type { AgenCToolUseContext } from "../../src/session/agenc-tool-use-context.js";
import { hasOnlySmallTextToolResults } from "../../src/services/compact/microCompact.js";
import { createToolResultIntegrity } from "../../src/session/tool-result-integrity.js";

vi.mock("../../src/utils/toolResultStorage.js", () => ({
  persistToolResult: vi.fn(async (_content: string, id: string) => ({ id })),
  buildLargeToolResultMessage: ({ id }: { id: string }) => `stored result ${id}`,
}));
afterEach(() => { vi.unstubAllEnvs(); });

test("uncompacted projection preserves the canonical roundtrip and optional wire fields", () => {
  const messages: LLMMessage[] = [
    { role: "system", content: "system", toolCalls: [{ id: "ignored", name: "x", arguments: "{}" }] },
    { role: "developer", content: "developer" },
    { role: "user", content: [{ type: "text", text: "user" }] },
    { role: "assistant", content: null, phase: "commentary", providerReasoningContent: "reasoning",
      providerReasoningProvenance: { provider: "deepseek", model: "test" },
      toolCalls: [{ id: "call", name: "exec_command", arguments: "{}" }] },
    { role: "tool", content: "result", toolCallId: "call", toolName: "exec_command", runtimeOnly: {
      toolResultIntegrity: createToolResultIntegrity({ runId: "test", toolCallId: "call", content: "result" }),
    } },
    { role: "assistant", content: "done", phase: "final_answer" },
  ];
  expect(projectUncompactedLlmMessages(messages)).toEqual(fromAgenCRuntimeMessages(toAgenCRuntimeMessages(messages)));
  expect(hasOnlySmallTextToolResults([{ role: "tool", content: "x".repeat(5999) }])).toBe(true);
  expect(hasOnlySmallTextToolResults([{ role: "tool", content: "x".repeat(6000) }])).toBe(false);
  expect(hasOnlySmallTextToolResults([{ role: "user", content: "x".repeat(6000) }])).toBe(true);
  expect(hasOnlySmallTextToolResults([{ role: "tool", content: [{ type: "text", text: "small" }] }])).toBe(true);
  expect(hasOnlySmallTextToolResults([{ role: "tool", content: [{ type: "image_url", image_url: { url: "x" } }] }])).toBe(false);
});

test.each(["small", "aggregate", "large", "retained", "blocks", "reasoning"])("fast query projection preserves %s context and budget state", async kind => {
  vi.stubEnv("AGENC_TOOL_RESULT_BUDGET_CHARS", kind === "aggregate" ? "5000" : "200000");
  const resultSize = kind === "large" ? 25000 : kind === "aggregate" ? 3000 : 20;
  const messages: LLMMessage[] = [{ role: "user", content: "task" }];
  for (let i = 0; i < 12; i++) {
    if (kind !== "aggregate" || i === 0) messages.push({ role: "assistant", content: "",
      ...(kind === "reasoning" ? { providerReasoningContent: "reason".repeat(20000) } : {}),
      toolCalls: [{ id: String(i), name: "exec_command", arguments: "{}" }] });
    messages.push({ role: "tool", toolCallId: String(i), toolName: "exec_command",
      content: kind === "blocks" ? [{ type: "text", text: "result" }] : String(i).padEnd(resultSize, "x") });
  }
  const run = async (fast: boolean) => {
    const state = { seenIds: new Set<string>(), replacements: new Map<string, string>() };
    if (kind === "retained") { state.seenIds.add("0"); state.replacements.set("0", "retained".repeat(1000)); }
    const prepare = () => prepareAgenCQueryMessages({ messages, contentReplacementState: state, querySource: "test",
      toolUseContext: { options: { contextWindowTokens: kind === "reasoning" ? 32000 : 131072 } } as AgenCToolUseContext });
    const first = fast ? await withOneShotFastMode(prepare) : await prepare();
    const second = fast ? await withOneShotFastMode(prepare) : await prepare();
    expect(second).toEqual(first);
    return { first, state };
  };
  expect(await run(true)).toEqual(await run(false));
});
