/**
 * A deterministic durable history that exercises every field the checkpoint
 * prefix digest authenticates. Messages are in the live form run-turn holds
 * after persisting them: tool results are sealed and carry the persisted
 * identity of their durable (redacted) record.
 *
 * checkpoint-prefix-golden.ts was produced from this corpus by the
 * unmodified r4/base 6a19c87fd implementation, so tests can compare the
 * digests of the current writer with the digests of the old one.
 */
import type { LLMMessage } from "../../../src/llm/types.js";
import type { ResponseItem } from "../../../src/session/rollout-item.js";
import {
  createCsvAgentInvocationEnvelope,
  materializeAgentInvocationMessages,
} from "../../../src/contracts/agent-invocation-envelope.js";
import { llmMessageToDurableResponseItem } from "../../../src/session/message-history-conversion.js";
import { createToolResultIntegrity } from "../../../src/session/tool-result-integrity.js";

export const CORPUS_RUN_ID = "conv-checkpoint-corpus";

const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PDF_STUB = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");
const durableRecords = new WeakMap<LLMMessage, ResponseItem>();

/** The response item run-turn persisted for a message of this corpus. */
export function persistedResponseItem(message: LLMMessage): ResponseItem {
  return durableRecords.get(message) ?? llmMessageToDurableResponseItem(message);
}

/** Seal a tool result exactly as run-turn does before and after persistence. */
export function sealedToolResult(
  toolCallId: string,
  content: LLMMessage["content"],
  options: { readonly toolName?: string; readonly isError?: boolean; readonly responseItemId?: string } = {},
): LLMMessage {
  const message: LLMMessage = {
    role: "tool",
    content,
    toolCallId,
    ...(options.toolName !== undefined ? { toolName: options.toolName } : {}),
    runtimeOnly: {
      ...(options.responseItemId !== undefined ? { responseItemId: options.responseItemId } : {}),
      ...(options.isError === true ? { toolResultIsError: true as const } : {}),
      toolResultIntegrity: createToolResultIntegrity({ runId: CORPUS_RUN_ID, toolCallId, content }),
    },
  };
  const durable = llmMessageToDurableResponseItem(message);
  const integrity = message.runtimeOnly!.toolResultIntegrity!;
  message.runtimeOnly = {
    ...message.runtimeOnly,
    toolResultIntegrity: {
      ...integrity,
      original: { ...integrity.original },
      persisted: durable.toolResultIntegrity!.persisted,
    },
  };
  durableRecords.set(message, durable);
  return message;
}

/** In-memory retention replaces an old body while its sealed identity stays. */
export function boundedToolResult(message: LLMMessage, replacement: string): LLMMessage {
  const bounded = { ...message, content: replacement };
  const durable = durableRecords.get(message);
  if (durable !== undefined) durableRecords.set(bounded, durable);
  return bounded;
}

export function assistantToolCall(
  index: number,
  calls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly arguments: string }>,
  reasoning = `Thinking about step ${index}: read the file, then check the result.`,
): LLMMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: calls.map((call) => ({ ...call })),
    providerReasoningContent: reasoning,
    providerReasoningProvenance: { provider: "deepseek", model: "deepseek-flash" },
    phase: "commentary",
    runtimeOnly: { responseItemId: `resp-assistant-${index}` },
  };
}

export interface CheckpointPrefixCorpus {
  /** Messages as run-turn holds them, including one bounded in memory. */
  readonly live: LLMMessage[];
  /** The response items persisted for them, before any in-memory bound. */
  readonly durable: ResponseItem[];
}

/** Every message kind the v4 prefix digest covers, in a valid order. */
export function checkpointPrefixCorpus(): CheckpointPrefixCorpus {
  const live = corpusMessages().map((message) =>
    message.toolCallId === "call-5" ? boundedToolResult(message, "[Old tool result content cleared]") : message);
  return { live, durable: live.map(persistedResponseItem) };
}

function corpusMessages(): LLMMessage[] {
  const invocation = materializeAgentInvocationMessages(createCsvAgentInvocationEnvelope({
    jobId: "corpus-job",
    itemId: "corpus-item",
    rowIndex: 7,
    rowSha256: `sha256:${"c".repeat(64)}`,
    instruction: "Classify the exact row.",
    row: { payload: "untrusted row text" },
  })).map((message) => ({
    role: message.role,
    content: message.content,
    runtimeOnly: { ...message.runtimeOnly! },
  }) satisfies LLMMessage);
  return [
    { role: "user", content: "Fix the parser in src/ünïcode.ts \u{1F680} and run the tests 测试", runtimeOnly: { responseItemId: "resp-user-1", userMessageId: "resp-user-1" } },
    { role: "developer", content: "Workspace instructions: keep changes minimal." },
    assistantToolCall(1, [
      { id: "call-1", name: "Read", arguments: JSON.stringify({ file_path: "/workspace/src/ünïcode.ts" }) },
      { id: "call-2", name: "exec_command", arguments: JSON.stringify({ cmd: "ls -la", yield_time_ms: 1000 }) },
    ]),
    sealedToolResult("call-1", "export const parse = (s: string) => s.split(',');\n", { toolName: "Read" }),
    sealedToolResult("call-2", "total 8\n-rw-r--r-- 1 user user 42 parser.ts\n", { toolName: "exec_command" }),
    assistantToolCall(2, [
      { id: "call-3", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) },
    ], ""),
    sealedToolResult("call-3", "FAIL tests/parser.test.ts\nexpected 3 items, got 2", { toolName: "exec_command", isError: true }),
    assistantToolCall(3, [
      { id: "call-4", name: "exec_command", arguments: JSON.stringify({ cmd: "cat .env" }) },
    ]),
    // The durable record redacts the credential, so the persisted identity
    // differs from the original one.
    sealedToolResult("call-4", "API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz0123456789\nDEBUG=1\n", { toolName: "exec_command" }),
    sealedToolResult("call-5", `${"large build log line\n".repeat(400)}done\n`, { toolName: "exec_command", responseItemId: "resp-tool-5" }),
    {
      role: "assistant",
      content: "The parser now splits on commas and trims whitespace.",
      providerReasoningContent: "Legacy reasoning replay without provenance.",
      phase: "final_answer",
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Here is a screenshot of the failure." },
        { type: "image_url", image_url: { url: PNG_1X1 } },
      ],
      runtimeOnly: { responseItemId: "resp-user-2", userMessageId: "resp-user-2" },
    },
    assistantToolCall(4, [
      { id: "call-6", name: "Read", arguments: JSON.stringify({ file_path: "/workspace/spec.pdf" }) },
    ]),
    sealedToolResult("call-6", [
      { type: "text", text: "spec.pdf (1 page)" },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF_STUB }, title: "spec", filename: "spec.pdf", fallbackText: "Spec text" },
    ], { toolName: "Read" }),
    {
      role: "developer",
      content: "Earlier conversation was compacted.",
      runtimeOnly: {
        responseItemId: "resp-compact-boundary",
        compactionHistory: { version: 1, kind: "boundary", attempt_id: "compact-corpus", summary_sha256: "d".repeat(64) },
      },
    },
    {
      role: "user",
      content: "Summary: the parser was fixed and tests pass.",
      runtimeOnly: {
        responseItemId: "resp-compact-summary",
        compactionHistory: { version: 1, kind: "summary", attempt_id: "compact-corpus", summary_sha256: "d".repeat(64) },
      },
    },
    ...invocation,
    {
      role: "assistant",
      content: "Done.",
      phase: "final_answer",
      runtimeOnly: { responseItemId: "resp-final" },
    },
  ];
}
