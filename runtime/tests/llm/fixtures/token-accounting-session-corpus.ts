/**
 * A deterministic growing session for request token accounting: every model
 * call of a tool-heavy DeepSeek conversation counts the whole history so far.
 * Messages carry what live requests carry: reasoning replay with provenance,
 * parallel tool calls, sealed tool results (lazy and eager seals), Unicode
 * that every normalization form changes, an inline image, a developer note
 * and a merged pair of user messages.
 *
 * token-accounting-session-golden.json holds the results of these requests
 * from the unmodified r4/ck 98d984fa9 implementation (whole-request
 * snapshot, JSON serialization and normalization on every count).
 */
import {
  createTokenAccountingRequest,
  type TokenAccountingRequest,
} from "../../../src/llm/token-accounting.js";
import type { LLMMessage, LLMTool } from "../../../src/llm/types.js";
import {
  createDeferredTextToolResultIntegrity,
  createToolResultIntegrity,
} from "../../../src/session/tool-result-integrity.js";

export const SESSION_CORPUS_RUN_ID = "conv-token-accounting-corpus";
export const SESSION_CORPUS_CALLS = 40;

const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Text whose length changes under NFC, NFD, NFKC or NFKD. */
const UNICODE = [
  "é",           // decomposed é (NFC composes)
  "é",            // precomposed é (NFD decomposes)
  "각", // Hangul jamo (NFC composes to one syllable)
  "각",            // Hangul syllable (NFD decomposes)
  "ﬁ",            // ﬁ ligature (NFKC expands to fi)
  "ﷺ",            // Arabic ligature (NFKC expands to 18 letters)
  "⑴",            // parenthesized one (NFKC to "(1)")
  "Ａ",            // fullwidth A
  "Ǻ",     // stacked marks
  "̈́",            // decomposes into two marks
  "\u{1f680}\u{1f469}‍\u{1f4bb}", // emoji, ZWJ sequence
  "测试数据",
  "क़",
] as const;

function unicode(index: number): string {
  return UNICODE[index % UNICODE.length]!;
}

export const SESSION_CORPUS_TOOLS: readonly LLMTool[] = ["FileRead", "exec_command", "Edit", "Write"].map((name) => ({
  type: "function" as const,
  function: {
    name,
    description: `${name}: one precise operation; paths are absolute. ${unicode(name.length)}`,
    parameters: {
      type: "object",
      properties: { file_path: { type: "string" }, cmd: { type: "string" }, limit: { type: "number" } },
      required: [],
    },
  },
}));

export const SESSION_CORPUS_SYSTEM_PROMPT =
  "You are AgenC, a careful coding agent. Read before you edit, run the tests, report exactly. ".repeat(40);

/** The history after `calls` tool rounds (index 0 is the user's prompt). */
export function sessionCorpusHistory(calls: number): LLMMessage[] {
  const history: LLMMessage[] = [
    { role: "user", content: `Fix the parser in src/ünïcode.ts ${unicode(0)} and keep the tests green.` },
    { role: "user", content: [{ type: "text", text: `Screenshot of the failure ${unicode(2)}` }, { type: "image_url", image_url: { url: PNG_1X1 } }] },
  ];
  for (let index = 1; index <= calls; index += 1) {
    const ids = index % 9 === 0 ? [`call-${index}-a`, `call-${index}-b`] : [`call-${index}`];
    history.push({
      role: "assistant",
      content: index % 7 === 0 ? `Checking ${unicode(index)} before the next read.` : "",
      toolCalls: ids.map((id, slot) => ({
        id,
        name: slot === 0 ? "FileRead" : "exec_command",
        arguments: JSON.stringify(slot === 0
          ? { file_path: `/workspace/src/module-${index}-${unicode(index + 3)}.ts`, limit: 400 }
          : { cmd: `grep -n "${unicode(index + 5)}" src/*.ts` }),
      })),
      providerReasoningContent: `Step ${index}: compare the parsed values ${unicode(index + 1)} with the fixture; ${"read the next module carefully. ".repeat(6)}`,
      providerReasoningProvenance: { provider: "deepseek", model: "deepseek-flash" },
      phase: "commentary",
      runtimeOnly: { responseItemId: `resp-${index}` },
    });
    for (const id of ids) {
      const content = `${"export const value = compute(input);\n".repeat(8 + (index % 5))}// ${unicode(index + id.length)}\n`;
      history.push({
        role: "tool",
        content,
        toolCallId: id,
        toolName: id.endsWith("-b") ? "exec_command" : "FileRead",
        runtimeOnly: {
          responseItemId: `resp-tool-${id}`,
          toolResultIntegrity: index % 2 === 0
            ? createDeferredTextToolResultIntegrity({ runId: SESSION_CORPUS_RUN_ID, toolCallId: id, content })
            : createToolResultIntegrity({ runId: SESSION_CORPUS_RUN_ID, toolCallId: id, content }),
        },
      });
    }
    if (index % 13 === 0) {
      history.push({ role: "developer", content: `Workspace note ${index}: keep changes minimal ${unicode(index)}.` });
    }
    if (index === 20) {
      // Two queued follow-ups: the provider wire merges consecutive user text.
      history.push({ role: "user", content: `Also check the CSV reader ${unicode(6)}.` });
      history.push({ role: "user", content: "And keep the public API unchanged." });
    }
  }
  return history;
}

export interface SessionCorpusRequest {
  readonly label: string;
  readonly calls: number;
  readonly provider: string;
  readonly model: string;
  readonly withTools: boolean;
}

/** Every call of the session counted as DeepSeek, plus a few other envelopes. */
export function sessionCorpusRequests(): SessionCorpusRequest[] {
  const requests: SessionCorpusRequest[] = [];
  for (let calls = 0; calls <= SESSION_CORPUS_CALLS; calls += 1) {
    requests.push({ label: `deepseek-${calls}`, calls, provider: "deepseek", model: "deepseek-flash", withTools: true });
    if (calls % 10 === 5) {
      requests.push({ label: `openai-${calls}`, calls, provider: "openai", model: "gpt-6.1", withTools: true });
      requests.push({ label: `deepseek-no-tools-${calls}`, calls, provider: "deepseek", model: "deepseek-flash", withTools: false });
    }
  }
  return requests;
}

export function sessionCorpusAccountingRequest(
  spec: SessionCorpusRequest,
  messages: readonly LLMMessage[],
  calibrationScope = "conv-token-accounting-corpus",
): TokenAccountingRequest {
  return createTokenAccountingRequest({
    provider: spec.provider,
    model: spec.model,
    calibrationScope,
    messages,
    options: {
      model: spec.model,
      systemPrompt: SESSION_CORPUS_SYSTEM_PROMPT,
      ...(spec.withTools ? { tools: [...SESSION_CORPUS_TOOLS], toolChoice: "auto" as const } : {}),
      maxOutputTokens: 32_000,
      reasoningEffort: "high",
      parallelToolCalls: true,
    },
    contextWindowTokens: 1_000_000,
    reservedOutputTokens: 32_000,
  });
}

