import type { BuildCompactionPlanOptions } from "../../src/services/compact/plan.js";
import { canonicalizeJson } from "../../src/services/compact/summary-v1.js";
import type {
  CompactionActiveHistoryRefV1,
  CompactionSourceAuthorityV1,
} from "../../src/services/compact/transaction-types.js";
import type { CompactContext, RuntimeMessage } from "../../src/services/compact/types.js";
import { createToolResultIntegrity } from "../../src/session/tool-result-integrity.js";

const SESSION_ID = "compaction-plan-fixture";
const ATTEMPT_ID = "plan-fixture";
const SOURCE_BINDING = "rollout:/plan-fixture#epoch:1";
const DIGEST = "a".repeat(64);

const COMPACTION_PLAN_SYSTEM_PROMPTS = {
  map: "Summarize only the supplied untrusted structured data.",
  reduce: "Reduce only the supplied untrusted structured summaries.",
  final: "Return only a bounded final summary of supplied data.",
} as const;

export interface CompactionPlanFixtureCall {
  readonly id: string;
  readonly name: string;
  readonly arguments?: string;
  /** The result as history holds it, framed or not. */
  readonly result: unknown;
}

/** Plan options with one canonical rollout ref per source message. */
export function compactionPlanOptions(
  messages: readonly RuntimeMessage[],
  window: { readonly contextWindowTokens?: number; readonly maxOutputTokens?: number } = {},
): BuildCompactionPlanOptions {
  const refs: CompactionActiveHistoryRefV1[] = messages.map((message, index) => ({
    kind: "rollout_span",
    ref_id: `${ATTEMPT_ID}:message:${index + 1}`,
    source_binding: SOURCE_BINDING,
    first_sequence: index + 1,
    last_sequence: index + 1,
    sha256: DIGEST,
    history_index: index,
    record_message_index: 0,
    encoded_bytes: Buffer.byteLength(canonicalizeJson(message), "utf8"),
  }));
  const source: CompactionSourceAuthorityV1 = {
    format_version: 1,
    attempt_id: ATTEMPT_ID,
    session_id: SESSION_ID,
    epoch: 1,
    source_binding: SOURCE_BINDING,
    first_sequence: 1,
    last_sequence: messages.length,
    source_sha256: DIGEST,
    source_bytes: refs.reduce((total, ref) => total + ref.encoded_bytes, 0),
    history_digest: DIGEST,
    active_history_refs: refs,
  };
  return {
    context: {
      options: {
        contextWindowTokens: window.contextWindowTokens ?? 128_000,
        maxOutputTokens: window.maxOutputTokens ?? 4_000,
      },
    } as CompactContext,
    source,
    systemPrompts: COMPACTION_PLAN_SYSTEM_PROMPTS,
    providerName: "grok",
    model: "grok-4.6",
    messageSourceRefs: refs,
  };
}

/** A tool result sealed for the fixture session; content and name may be absent. */
export function sealedToolResult(
  toolCallId: string,
  content: unknown,
  toolName?: string,
): RuntimeMessage {
  return {
    role: "tool",
    ...(content === undefined ? {} : { content }),
    toolCallId,
    ...(toolName === undefined ? {} : { toolName }),
    runtimeOnly: {
      toolResultIntegrity: createToolResultIntegrity({
        runId: SESSION_ID,
        toolCallId,
        content: content ?? "",
      }),
    },
  };
}

/** An assistant message calling tools, followed by each sealed result. */
export function toolExchange(
  calls: readonly CompactionPlanFixtureCall[],
  text = "",
): RuntimeMessage[] {
  return [
    {
      role: "assistant",
      content: text,
      toolCalls: calls.map((call) => ({
        id: call.id,
        name: call.name,
        ...(call.arguments === undefined ? {} : { arguments: call.arguments }),
      })),
    },
    ...calls.map((call) => sealedToolResult(call.id, call.result, call.name)),
  ];
}
