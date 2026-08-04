import {
  assertTokenAccountingWithinContext,
  createTokenAccountingRequest,
  estimateTokenAccountingRequest,
  requireAdmissibleTokenAccounting,
  type TokenAccountingResult,
} from "../../llm/token-accounting.js";
import type { LLMChatOptions, LLMMessage } from "../../llm/types.js";
import { messageText } from "./_deps/runtime.js";
import { canonicalizeJson, sha256Hex } from "./summary-v1.js";
import {
  COMPACTION_SOURCE_DIGEST_DOMAIN,
  MAX_COMPACTION_CHUNKS,
  MAX_COMPACTION_FAN_IN,
  MAX_COMPACTION_INTERMEDIATE_TOKENS,
  MAX_COMPACTION_RECORD_TEXT_UTF8_BYTES,
  MAX_COMPACTION_PROVIDER_CALLS,
  MAX_COMPACTION_REDUCTION_LEVELS,
  MAX_COMPACTION_SEMANTIC_UNITS,
  MAX_COMPACTION_SOURCE_BYTES,
  MAX_COMPACTION_SOURCE_MESSAGES,
  MAX_COMPACTION_TOTAL_INPUT_TOKENS,
  MAX_COMPACTION_TOOL_PAIRS_PER_OUTPUT,
  type CompactionSourceAuthorityV1,
  type CompactionToolPairV1,
  type RolloutSpanRefV1,
  CompactionCannotReduceError,
  CompactionTransactionError,
} from "./transaction-types.js";
import type { CompactContext, RuntimeMessage } from "./types.js";
import { fromRuntimeMessageContent } from "../../llm/content-conversion.js";
import { verifyToolResultIntegrity } from "../../session/tool-result-integrity.js";

const COMPACTION_STRUCTURED_TRANSCRIPT_VERSION = 1 as const;
const COMPACTION_STRUCTURED_TRANSCRIPT_KIND =
  "untrusted_compaction_transcript" as const;
const COMPACTION_DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const COMPACTION_DEFAULT_OUTPUT_RESERVE_TOKENS = 4_000;
const COMPACTION_MINIMUM_INPUT_TOKEN_BUDGET = 1_024;

interface StructuredMessageV1 {
  readonly role: string;
  readonly content: unknown;
  readonly tool_call_id?: string;
  readonly tool_name?: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments?: string;
  }[];
  readonly tool_result_sha256?: string;
}

export interface CompactionSemanticUnit {
  readonly unit_id: string;
  readonly first_message_index: number;
  readonly last_message_index: number;
  readonly messages: readonly StructuredMessageV1[];
  readonly canonical_json: string;
  readonly utf8_bytes: number;
  readonly tool_pairs: readonly CompactionToolPairV1[];
}

export interface CompactionChunkPlan {
  readonly index: number;
  readonly units: readonly CompactionSemanticUnit[];
  readonly source_ref: RolloutSpanRefV1;
  readonly messages: readonly LLMMessage[];
  readonly accounting: TokenAccountingResult;
  readonly tool_pairs: readonly CompactionToolPairV1[];
}

export interface CompactionMapReducePlan {
  readonly units: readonly CompactionSemanticUnit[];
  readonly chunks: readonly CompactionChunkPlan[];
  readonly leaf_refs: readonly RolloutSpanRefV1[];
  readonly maximum_levels: number;
  readonly planned_provider_calls: number;
  readonly planned_input_tokens: number;
  readonly context_window_tokens: number;
  readonly output_reserve_tokens: number;
  readonly reduction_fan_in: number;
  readonly tool_pairs: readonly CompactionToolPairV1[];
  readonly calls: readonly CompactionCallPlan[];
  /** Deterministic planner work counters; these are evidence, not timings. */
  readonly planning_work: CompactionPlanningWork;
}

export interface CompactionPlanningWork {
  readonly source_messages_scanned: number;
  readonly source_canonical_utf8_bytes: number;
  readonly semantic_units_built: number;
  readonly semantic_unit_utf8_bytes: number;
  readonly chunk_candidate_evaluations: number;
  readonly candidate_semantic_units_visited: number;
  readonly candidate_source_refs_visited: number;
  readonly candidate_transcript_utf8_bytes: number;
  readonly maximum_candidate_semantic_units: number;
  readonly token_estimator_calls: number;
}

interface MutableCompactionPlanningWork {
  source_messages_scanned: number;
  source_canonical_utf8_bytes: number;
  semantic_units_built: number;
  semantic_unit_utf8_bytes: number;
  chunk_candidate_evaluations: number;
  candidate_semantic_units_visited: number;
  candidate_source_refs_visited: number;
  candidate_transcript_utf8_bytes: number;
  maximum_candidate_semantic_units: number;
  token_estimator_calls: number;
}

interface CompactionChunkCandidate {
  readonly end: number;
  readonly units: readonly CompactionSemanticUnit[];
  readonly sourceRef: RolloutSpanRefV1;
  readonly messages: readonly LLMMessage[];
  readonly accounting: TokenAccountingResult;
}

export interface CompactionCallPlan {
  readonly call_index: number;
  readonly stage: "map" | "reduce" | "final";
  readonly level: number;
  readonly source_ref_ids: readonly string[];
  readonly result_ref_id: string;
  readonly input_token_upper_bound: number;
}

export interface BuildCompactionPlanOptions {
  readonly context: CompactContext;
  readonly source: CompactionSourceAuthorityV1;
  readonly systemPrompts: Readonly<Record<"map" | "reduce" | "final", string>>;
  readonly requestedFocus?: string;
  readonly providerName: string;
  readonly model: string;
  readonly messageSourceRefs: readonly RolloutSpanRefV1[];
}

/**
 * Build one deterministic, fully bounded map/reduce plan before the first
 * provider call. A tool invocation and all of its results are one semantic
 * unit and can never be separated by a chunk boundary.
 */
export function buildCompactionMapReducePlan(
  messages: readonly RuntimeMessage[],
  options: BuildCompactionPlanOptions,
): CompactionMapReducePlan {
  const planningWork = createPlanningWork();
  if (options.messageSourceRefs.length !== messages.length) {
    throw new CompactionTransactionError(
      "provenance_invalid",
      "authoritative source/message mapping is incomplete",
    );
  }
  if (messages.length > MAX_COMPACTION_SOURCE_MESSAGES) {
    throw new CompactionCannotReduceError(
      "source_limit",
      `compaction source exceeds ${MAX_COMPACTION_SOURCE_MESSAGES} messages`,
    );
  }
  const sourceBytes = measureCanonicalSourceBytes(messages, planningWork);
  if (sourceBytes > MAX_COMPACTION_SOURCE_BYTES) {
    throw new CompactionCannotReduceError(
      "source_limit",
      `compaction source exceeds ${MAX_COMPACTION_SOURCE_BYTES} UTF-8 bytes`,
    );
  }
  const modelMessages = createCompactionModelProjection(messages);
  const units = buildSemanticUnits(
    modelMessages,
    options.source.session_id,
    messages,
    planningWork,
  );
  if (units.length > MAX_COMPACTION_SEMANTIC_UNITS) {
    throw new CompactionCannotReduceError(
      "source_limit",
      `compaction source exceeds ${MAX_COMPACTION_SEMANTIC_UNITS} semantic units`,
    );
  }

  const contextWindow = positiveInteger(
    options.context.options?.contextWindowTokens,
    COMPACTION_DEFAULT_CONTEXT_WINDOW_TOKENS,
  );
  const outputReserve = Math.min(
    positiveInteger(
      options.context.options?.maxOutputTokens,
      COMPACTION_DEFAULT_OUTPUT_RESERVE_TOKENS,
    ),
    MAX_COMPACTION_INTERMEDIATE_TOKENS,
  );
  const planningSystemPrompt = Object.values(options.systemPrompts).reduce(
    (longest, prompt) => prompt.length > longest.length ? prompt : longest,
    "",
  );
  const commonOptions: LLMChatOptions = {
    model: options.model,
    systemPrompt: planningSystemPrompt,
    maxOutputTokens: outputReserve,
    contextWindowTokens: contextWindow,
  };

  const chunks: CompactionChunkPlan[] = [];
  let nextUnitIndex = 0;
  while (nextUnitIndex < units.length) {
    if (chunks.length >= MAX_COMPACTION_CHUNKS) {
      throw new CompactionCannotReduceError(
        "plan_limit",
        `compaction requires more than ${MAX_COMPACTION_CHUNKS} chunks`,
      );
    }
    const candidate = findMaximalChunkCandidate({
      units,
      start: nextUnitIndex,
      chunkIndex: chunks.length,
      options,
      commonOptions,
      contextWindow,
      outputReserve,
      planningWork,
    });
    if (candidate === null) {
      const unit = units[nextUnitIndex]!;
      throw new CompactionCannotReduceError(
        "semantic_unit_oversized",
        `semantic unit ${unit.unit_id} cannot fit the compaction request budget; retain its rollout span and tool artifact references`,
      );
    }
    assertTokenAccountingWithinContext(candidate.accounting, contextWindow);
    chunks.push({
      index: chunks.length,
      units: candidate.units,
      source_ref: candidate.sourceRef,
      messages: candidate.messages,
      accounting: candidate.accounting,
      tool_pairs: candidate.units.flatMap((unit) => unit.tool_pairs),
    });
    nextUnitIndex = candidate.end;
  }
  if (chunks.length === 0) {
    throw new CompactionCannotReduceError("source_limit", "compaction source is empty");
  }
  if (chunks.length > MAX_COMPACTION_CHUNKS) {
    throw new CompactionCannotReduceError(
      "plan_limit",
      `compaction requires ${chunks.length} chunks; maximum is ${MAX_COMPACTION_CHUNKS}`,
    );
  }
  const reductionFanIn = chunks.length === 1
    ? MAX_COMPACTION_FAN_IN
    : selectReductionFanIn({
        ...options,
        contextWindow,
        outputReserve,
      }, planningWork);
  const calls = buildCallDag(chunks, {
    ...options,
    contextWindow,
    outputReserve,
    reductionFanIn,
  }, planningWork);
  const topology = compactionMapReduceTopology(chunks.length, reductionFanIn);
  const toolPairs = units.flatMap((unit) => unit.tool_pairs);
  if (toolPairs.length > MAX_COMPACTION_TOOL_PAIRS_PER_OUTPUT) {
    throw new CompactionCannotReduceError(
      "source_limit",
      `compaction source has ${toolPairs.length} tool pairs; the final summary can preserve at most ${MAX_COMPACTION_TOOL_PAIRS_PER_OUTPUT}`,
    );
  }
  if (
    topology.levels > MAX_COMPACTION_REDUCTION_LEVELS ||
    topology.calls > MAX_COMPACTION_PROVIDER_CALLS
  ) {
    throw new CompactionCannotReduceError(
      "plan_limit",
      "compaction map/reduce tree exceeds its frozen level or call limit",
    );
  }
  // Reduction calls are preflighted using the frozen maximum intermediate
  // output per child, so runtime output cannot make a previously-valid plan
  // fan out or recurse.
  const plannedInput = calls.reduce(
    (total, call) => safeSum(total, call.input_token_upper_bound),
    0,
  );
  if (plannedInput > MAX_COMPACTION_TOTAL_INPUT_TOKENS) {
    throw new CompactionCannotReduceError(
      "plan_limit",
      `compaction plan exceeds ${MAX_COMPACTION_TOTAL_INPUT_TOKENS} total input tokens`,
    );
  }
  return {
    units,
    chunks,
    leaf_refs: chunks.map((chunk) => chunk.source_ref),
    maximum_levels: topology.levels,
    planned_provider_calls: topology.calls,
    planned_input_tokens: plannedInput,
    context_window_tokens: contextWindow,
    output_reserve_tokens: outputReserve,
    reduction_fan_in: reductionFanIn,
    tool_pairs: toolPairs,
    calls,
    planning_work: Object.freeze({ ...planningWork }),
  };
}

function createPlanningWork(): MutableCompactionPlanningWork {
  return {
    source_messages_scanned: 0,
    source_canonical_utf8_bytes: 0,
    semantic_units_built: 0,
    semantic_unit_utf8_bytes: 0,
    chunk_candidate_evaluations: 0,
    candidate_semantic_units_visited: 0,
    candidate_source_refs_visited: 0,
    candidate_transcript_utf8_bytes: 0,
    maximum_candidate_semantic_units: 0,
    token_estimator_calls: 0,
  };
}

/**
 * Find the exact maximal fitting prefix without probing the entire remaining
 * suffix for every chunk. Exponential growth establishes a local failure
 * bracket, then binary search resolves only that bracket. Every materialized
 * candidate is therefore no larger than the remaining source or twice the
 * preceding fitted prefix.
 */
function findMaximalChunkCandidate(params: {
  readonly units: readonly CompactionSemanticUnit[];
  readonly start: number;
  readonly chunkIndex: number;
  readonly options: BuildCompactionPlanOptions;
  readonly commonOptions: LLMChatOptions;
  readonly contextWindow: number;
  readonly outputReserve: number;
  readonly planningWork: MutableCompactionPlanningWork;
}): CompactionChunkCandidate | null {
  let best = evaluateChunkCandidate({ ...params, end: params.start + 1 });
  if (!chunkCandidateFits(best, params.contextWindow)) return null;

  let growth = 1;
  let firstFailingEnd: number | undefined;
  while (best.end < params.units.length) {
    const candidateEnd = Math.min(
      params.units.length,
      safeSum(best.end, growth),
    );
    const candidate = evaluateChunkCandidate({ ...params, end: candidateEnd });
    if (!chunkCandidateFits(candidate, params.contextWindow)) {
      firstFailingEnd = candidateEnd;
      break;
    }
    best = candidate;
    if (best.end === params.units.length) return best;
    growth = safeSum(growth, growth);
  }

  let low = best.end + 1;
  let high = (firstFailingEnd ?? best.end) - 1;
  while (low <= high) {
    const candidateEnd = low + Math.floor((high - low) / 2);
    const candidate = evaluateChunkCandidate({ ...params, end: candidateEnd });
    if (chunkCandidateFits(candidate, params.contextWindow)) {
      best = candidate;
      low = candidateEnd + 1;
    } else {
      high = candidateEnd - 1;
    }
  }
  return best;
}

function evaluateChunkCandidate(params: {
  readonly units: readonly CompactionSemanticUnit[];
  readonly start: number;
  readonly end: number;
  readonly chunkIndex: number;
  readonly options: BuildCompactionPlanOptions;
  readonly commonOptions: LLMChatOptions;
  readonly contextWindow: number;
  readonly outputReserve: number;
  readonly planningWork: MutableCompactionPlanningWork;
}): CompactionChunkCandidate {
  const units = params.units.slice(params.start, params.end);
  const sourceRef = chunkSourceRef(
    params.options.source,
    units,
    params.chunkIndex,
    params.options.messageSourceRefs,
  );
  const messages = structuredTranscriptMessages(
    units,
    [sourceRef.ref_id],
    params.options.requestedFocus,
  );
  const sourceRefCount = units.length === 0
    ? 0
    : units.at(-1)!.last_message_index - units[0]!.first_message_index + 1;
  params.planningWork.chunk_candidate_evaluations = safeSum(
    params.planningWork.chunk_candidate_evaluations,
    1,
  );
  params.planningWork.candidate_semantic_units_visited = safeSum(
    params.planningWork.candidate_semantic_units_visited,
    units.length,
  );
  params.planningWork.candidate_source_refs_visited = safeSum(
    params.planningWork.candidate_source_refs_visited,
    sourceRefCount,
  );
  params.planningWork.maximum_candidate_semantic_units = Math.max(
    params.planningWork.maximum_candidate_semantic_units,
    units.length,
  );
  params.planningWork.candidate_transcript_utf8_bytes = safeSum(
    params.planningWork.candidate_transcript_utf8_bytes,
    messagesUtf8Bytes(messages),
  );
  params.planningWork.token_estimator_calls = safeSum(
    params.planningWork.token_estimator_calls,
    1,
  );
  const accounting = accountCallWithoutContextAssertion(
    messages,
    params.commonOptions,
    params.options.providerName,
    params.options.model,
    params.contextWindow,
    params.outputReserve,
  );
  return { end: params.end, units, sourceRef, messages, accounting };
}

function chunkCandidateFits(
  candidate: CompactionChunkCandidate,
  contextWindow: number,
): boolean {
  return candidate.accounting.totalTokens <= contextWindow;
}

function messagesUtf8Bytes(messages: readonly LLMMessage[]): number {
  return messages.reduce((total, message) => safeSum(
    total,
    Buffer.byteLength(canonicalizeJson(message), "utf8"),
  ), 0);
}

function buildCallDag(
  chunks: readonly CompactionChunkPlan[],
  options: BuildCompactionPlanOptions & {
    readonly contextWindow: number;
    readonly outputReserve: number;
    readonly reductionFanIn: number;
  },
  planningWork: MutableCompactionPlanningWork,
): readonly CompactionCallPlan[] {
  const calls: CompactionCallPlan[] = [];
  const resultRef = (callIndex: number): string =>
    `${options.source.attempt_id}:summary:${String(callIndex).padStart(3, "0")}`;
  let level: Array<{ readonly callIndex: number; readonly refId: string }> = [];
  for (const chunk of chunks) {
    const callIndex = calls.length + 1;
    const stage = chunks.length === 1 ? "final" : "map";
    const accounting = accountPlannedCompactionCall({
      messages: chunk.messages,
      systemPrompt: options.systemPrompts[stage],
      providerName: options.providerName,
      model: options.model,
      contextWindowTokens: options.contextWindow,
      outputReserveTokens: options.outputReserve,
    }, planningWork);
    calls.push({
      call_index: callIndex,
      stage,
      level: 0,
      source_ref_ids: [chunk.source_ref.ref_id],
      result_ref_id: resultRef(callIndex),
      input_token_upper_bound: accounting.inputTokens,
    });
    level.push({ callIndex, refId: resultRef(callIndex) });
  }
  let reductionLevel = 1;
  while (level.length > 1) {
    const next: Array<{ readonly callIndex: number; readonly refId: string }> = [];
    for (let index = 0; index < level.length; index += options.reductionFanIn) {
      const group = level.slice(index, index + options.reductionFanIn);
      if (group.length === 1 && level.length > options.reductionFanIn) {
        next.push(group[0]!);
        continue;
      }
      const callIndex = calls.length + 1;
      const stage = level.length <= options.reductionFanIn ? "final" : "reduce";
      const messages = structuredReductionMessages({
        children: group.map((child) => ({
          ref_id: child.refId,
          sha256: "0".repeat(64),
          body: { narrative: "", facts: [], open_actions: [], tool_pairs: [] },
        })),
        stage,
        requestedFocus: options.requestedFocus,
      });
      const wrapper = accountPlannedCompactionCall({
        messages,
        systemPrompt: options.systemPrompts[stage],
        providerName: options.providerName,
        model: options.model,
        contextWindowTokens: options.contextWindow,
        outputReserveTokens: options.outputReserve,
      }, planningWork);
      const upperBound = safeSum(
        wrapper.inputTokens,
        group.length * options.outputReserve,
      );
      if (safeSum(upperBound, options.outputReserve) > options.contextWindow) {
        throw new CompactionCannotReduceError(
          "context_limit",
          `planned ${stage} call ${callIndex} cannot fit its frozen worst-case child outputs`,
        );
      }
      calls.push({
        call_index: callIndex,
        stage,
        level: reductionLevel,
        source_ref_ids: group.map((child) => child.refId),
        result_ref_id: resultRef(callIndex),
        input_token_upper_bound: upperBound,
      });
      next.push({ callIndex, refId: resultRef(callIndex) });
    }
    level = next;
    reductionLevel += 1;
  }
  return calls;
}

function selectReductionFanIn(
  options: BuildCompactionPlanOptions & {
    readonly contextWindow: number;
    readonly outputReserve: number;
  },
  planningWork: MutableCompactionPlanningWork,
): number {
  for (let candidate = MAX_COMPACTION_FAN_IN; candidate >= 2; candidate -= 1) {
    const messages = structuredReductionMessages({
      children: Array.from({ length: candidate }, (_, index) => ({
        ref_id: `preflight-child-${index}`,
        sha256: "0".repeat(64),
        body: { narrative: "", facts: [], open_actions: [], tool_pairs: [] },
      })),
      stage: "reduce",
      requestedFocus: options.requestedFocus,
    });
    const wrapper = accountPlannedCompactionCall({
      messages,
      systemPrompt: options.systemPrompts.reduce,
      providerName: options.providerName,
      model: options.model,
      contextWindowTokens: options.contextWindow,
      outputReserveTokens: options.outputReserve,
    }, planningWork);
    const childOutputs = candidate * options.outputReserve;
    if (
      safeSum(
        safeSum(wrapper.inputTokens, childOutputs),
        options.outputReserve,
      ) <= options.contextWindow
    ) {
      return candidate;
    }
  }
  throw new CompactionCannotReduceError(
    "context_limit",
    "compaction context cannot fit a two-child bounded reduction",
  );
}

export function structuredReductionMessages(params: {
  readonly children: readonly {
    readonly ref_id: string;
    readonly sha256: string;
    readonly body: unknown;
  }[];
  readonly stage: "reduce" | "final";
  readonly requestedFocus?: string;
}): readonly LLMMessage[] {
  if (params.children.length === 0 || params.children.length > MAX_COMPACTION_FAN_IN) {
    throw new CompactionCannotReduceError(
      "plan_limit",
      "compaction reduction fan-in is outside its frozen bound",
    );
  }
  return [
    {
      role: "user",
      content: canonicalizeJson({
        version: COMPACTION_STRUCTURED_TRANSCRIPT_VERSION,
        kind: "untrusted_compaction_summaries",
        stage: params.stage,
        coverage_priority: params.requestedFocus ?? "",
        allowed_source_ref_ids: params.children.map((child) => child.ref_id),
        summaries: params.children,
      }),
    },
  ];
}

export function accountCompactionCall(params: {
  readonly messages: readonly LLMMessage[];
  readonly systemPrompt: string;
  readonly providerName: string;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly outputReserveTokens: number;
}): TokenAccountingResult {
  return accountCall(
    params.messages,
    {
      model: params.model,
      systemPrompt: params.systemPrompt,
      maxOutputTokens: params.outputReserveTokens,
      contextWindowTokens: params.contextWindowTokens,
    },
    params.providerName,
    params.model,
    params.contextWindowTokens,
    params.outputReserveTokens,
  );
}

function accountPlannedCompactionCall(
  params: Parameters<typeof accountCompactionCall>[0],
  planningWork: MutableCompactionPlanningWork,
): TokenAccountingResult {
  planningWork.token_estimator_calls = safeSum(
    planningWork.token_estimator_calls,
    1,
  );
  return accountCompactionCall(params);
}

function buildSemanticUnits(
  messages: readonly RuntimeMessage[],
  sourceSessionId: string,
  authoritativeMessages: readonly RuntimeMessage[],
  planningWork: MutableCompactionPlanningWork,
): readonly CompactionSemanticUnit[] {
  const units: CompactionSemanticUnit[] = [];
  const allToolCallIds = new Set<string>();
  let index = 0;
  while (index < messages.length) {
    const first = messages[index]!;
    const firstStructured = structuredMessage(first);
    const toolCalls = first.toolCalls ?? [];
    if (toolCalls.length > 0 && roleOf(first) !== "assistant") {
      throw new CompactionTransactionError(
        "provenance_invalid",
        "only assistant messages may declare tool calls",
      );
    }
    const expectedToolIds = new Set<string>();
    const declaredToolIds: string[] = [];
    for (const call of toolCalls) {
      if (call.id.trim().length === 0) {
        throw new CompactionTransactionError(
          "provenance_invalid",
          "compaction source contains an empty tool-call id",
        );
      }
      if (expectedToolIds.has(call.id)) {
        throw new CompactionTransactionError(
          "provenance_invalid",
          `compaction source contains duplicate tool-call id ${call.id}`,
        );
      }
      if (allToolCallIds.has(call.id)) {
        throw new CompactionTransactionError(
          "provenance_invalid",
          `compaction source reuses tool-call id ${call.id}`,
        );
      }
      expectedToolIds.add(call.id);
      declaredToolIds.push(call.id);
      allToolCallIds.add(call.id);
    }
    const unitMessages: StructuredMessageV1[] = [firstStructured];
    const toolPairs: CompactionToolPairV1[] = [];
    const firstIndex = index;
    index += 1;
    if (expectedToolIds.size > 0) {
      const unresolved = new Set(expectedToolIds);
      while (index < messages.length && roleOf(messages[index]!) === "tool") {
        const result = messages[index]!;
        const callId = result.toolCallId?.trim();
        const expectedCallId = declaredToolIds[toolPairs.length];
        if (
          !callId ||
          callId !== expectedCallId ||
          !unresolved.delete(callId)
        ) {
          throw new CompactionTransactionError(
            "provenance_invalid",
            "tool-result ordering or identity is not representable as one semantic unit",
          );
        }
        const authoritativeResult = authoritativeMessages[index]!;
        const verification = verifyToolResultIntegrity({
          integrity: authoritativeResult.runtimeOnly?.toolResultIntegrity,
          expectedRunId: sourceSessionId,
          toolCallId: callId,
          content:
            authoritativeResult.content ??
            authoritativeResult.message?.content ??
            "",
        });
        if (verification.status !== "valid") {
          throw new CompactionTransactionError(
            "provenance_invalid",
            `tool result ${callId} lacks exact immutable original-body integrity`,
          );
        }
        toolPairs.push({
          tool_call_id: callId,
          result_sha256: verification.integrity.original.digest.replace(
            /^sha256:/u,
            "",
          ),
        });
        unitMessages.push(structuredMessage(result));
        index += 1;
      }
      if (unresolved.size !== 0) {
        throw new CompactionTransactionError(
          "provenance_invalid",
          "compaction source contains an unresolved tool use/result pair",
        );
      }
    } else if (roleOf(first) === "tool") {
      throw new CompactionTransactionError(
        "provenance_invalid",
        "compaction source contains an orphaned tool result",
      );
    }
    const canonical = canonicalizeJson(unitMessages);
    const utf8Bytes = Buffer.byteLength(canonical, "utf8");
    planningWork.semantic_units_built = safeSum(
      planningWork.semantic_units_built,
      1,
    );
    planningWork.semantic_unit_utf8_bytes = safeSum(
      planningWork.semantic_unit_utf8_bytes,
      utf8Bytes,
    );
    units.push({
      unit_id: `unit-${String(units.length + 1).padStart(6, "0")}`,
      first_message_index: firstIndex,
      last_message_index: index - 1,
      messages: unitMessages,
      canonical_json: canonical,
      utf8_bytes: utf8Bytes,
      tool_pairs: toolPairs,
    });
  }
  return units;
}

/**
 * Build the untrusted provider-facing projection without releasing binary
 * media, data URLs, or document bodies. Provenance continues to bind the
 * untouched authoritative message and its canonical source ref.
 */
function createCompactionModelProjection(
  messages: readonly RuntimeMessage[],
): readonly RuntimeMessage[] {
  return messages.map((message) => {
    const content = message.content ?? message.message?.content;
    if (!Array.isArray(content)) return message;
    const projectedContent = content.map(redactCompactionContentPart);
    return {
      ...message,
      content: projectedContent,
      ...(message.message === undefined
        ? {}
        : { message: { ...message.message, content: projectedContent } }),
    };
  });
}

function redactCompactionContentPart(part: unknown): unknown {
  if (part === null || typeof part !== "object" || Array.isArray(part)) {
    return { type: "text", text: mediaPlaceholder(part, "unknown") };
  }
  const record = part as Readonly<Record<string, unknown>>;
  if (record.type === "text" && typeof record.text === "string") {
    return { type: "text", text: record.text };
  }
  if (record.type === "document") {
    const fallback = typeof record.fallbackText === "string"
      ? truncateUtf8(record.fallbackText, MAX_COMPACTION_RECORD_TEXT_UTF8_BYTES)
      : "";
    const label = mediaPlaceholder(part, "document");
    return {
      type: "text",
      text: fallback.length > 0 ? `${label}\n${fallback}` : label,
    };
  }
  if (record.type === "image" || record.type === "image_url") {
    return { type: "text", text: mediaPlaceholder(part, "image") };
  }
  return { type: "text", text: mediaPlaceholder(part, "unsupported-content") };
}

function mediaPlaceholder(value: unknown, kind: string): string {
  return `[${kind} omitted from compaction model input; sha256:${sha256Hex(
    canonicalizeJson(value),
  )}]`;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + codePointBytes > maximumBytes) break;
    bytes += codePointBytes;
    end += codePoint.length;
  }
  return value.slice(0, end);
}

function measureCanonicalSourceBytes(
  messages: readonly RuntimeMessage[],
  planningWork: MutableCompactionPlanningWork,
): number {
  let bytes = 2;
  for (let index = 0; index < messages.length; index += 1) {
    if (index > 0) bytes = safeSum(bytes, 1);
    planningWork.source_messages_scanned = safeSum(
      planningWork.source_messages_scanned,
      1,
    );
    bytes = safeSum(
      bytes,
      Buffer.byteLength(canonicalizeJson(messageForDigest(messages[index]!)), "utf8"),
    );
    planningWork.source_canonical_utf8_bytes = bytes;
    if (bytes > MAX_COMPACTION_SOURCE_BYTES) return bytes;
  }
  return bytes;
}

function structuredMessage(message: RuntimeMessage): StructuredMessageV1 {
  const role = roleOf(message);
  const content = message.content ?? message.message?.content ?? "";
  const resultDigest = message.runtimeOnly?.toolResultIntegrity?.original.digest;
  return {
    role,
    content,
    ...(message.toolCallId !== undefined ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolName !== undefined ? { tool_name: message.toolName } : {}),
    ...(message.toolCalls !== undefined
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            ...(call.arguments !== undefined ? { arguments: call.arguments } : {}),
          })),
        }
      : {}),
    ...(resultDigest !== undefined
      ? { tool_result_sha256: resultDigest.replace(/^sha256:/u, "") }
      : {}),
  };
}

function roleOf(message: RuntimeMessage): string {
  return message.originalRole ?? message.role ?? message.message?.role ?? "user";
}

function structuredTranscriptMessages(
  units: readonly CompactionSemanticUnit[],
  allowedSourceRefIds: readonly string[],
  requestedFocus: string | undefined,
): readonly LLMMessage[] {
  return [
    {
      role: "user",
      content: canonicalizeJson({
        version: COMPACTION_STRUCTURED_TRANSCRIPT_VERSION,
        kind: COMPACTION_STRUCTURED_TRANSCRIPT_KIND,
        coverage_priority: requestedFocus ?? "",
        allowed_source_ref_ids: allowedSourceRefIds,
        units: units.map((unit) => ({
          unit_id: unit.unit_id,
          messages: unit.messages,
        })),
      }),
    },
  ];
}

function chunkSourceRef(
  source: CompactionSourceAuthorityV1,
  units: readonly CompactionSemanticUnit[],
  chunkIndex: number,
  messageSourceRefs: readonly RolloutSpanRefV1[],
): RolloutSpanRefV1 {
  const first = units[0];
  const last = units.at(-1);
  if (first === undefined || last === undefined) {
    throw new CompactionCannotReduceError("plan_limit", "empty compaction chunk");
  }
  const contributing = messageSourceRefs.slice(
    first.first_message_index,
    last.last_message_index + 1,
  );
  const firstAuthority = contributing[0];
  const lastAuthority = contributing.at(-1);
  if (firstAuthority === undefined || lastAuthority === undefined) {
    throw new CompactionTransactionError(
      "provenance_invalid",
      "compaction chunk has no canonical rollout-item mapping",
    );
  }
  const firstSequence = firstAuthority.first_sequence;
  const lastSequence = lastAuthority.last_sequence;
  const sha256 = sha256Hex(
    `${COMPACTION_SOURCE_DIGEST_DOMAIN}${canonicalizeJson(
      {
        source_sha256: source.source_sha256,
        message_sources: contributing,
      },
    )}`,
  );
  return {
    kind: "rollout_span",
    ref_id: `${source.attempt_id}:span:${String(chunkIndex + 1).padStart(3, "0")}`,
    source_binding: source.source_binding,
    first_sequence: firstSequence,
    last_sequence: lastSequence,
    sha256,
    first_history_index:
      firstAuthority.first_history_index ?? first.first_message_index,
    last_history_index:
      lastAuthority.last_history_index ?? last.last_message_index,
    contributing_ref_ids: contributing.flatMap((ref) =>
      ref.contributing_ref_ids ?? [ref.ref_id]
    ),
  };
}

function accountCall(
  messages: readonly LLMMessage[],
  options: LLMChatOptions,
  providerName: string,
  model: string,
  contextWindow: number,
  outputReserve: number,
): TokenAccountingResult {
  const accounting = accountCallWithoutContextAssertion(
    messages,
    options,
    providerName,
    model,
    contextWindow,
    outputReserve,
  );
  assertTokenAccountingWithinContext(accounting, contextWindow);
  return accounting;
}

function accountCallWithoutContextAssertion(
  messages: readonly LLMMessage[],
  options: LLMChatOptions,
  providerName: string,
  model: string,
  contextWindow: number,
  outputReserve: number,
): TokenAccountingResult {
  if (contextWindow - outputReserve < COMPACTION_MINIMUM_INPUT_TOKEN_BUDGET) {
    throw new CompactionCannotReduceError(
      "context_limit",
      "model context leaves no bounded compaction input budget after output reserve",
    );
  }
  const result = estimateTokenAccountingRequest(
    createTokenAccountingRequest({
      provider: providerName,
      model,
      messages,
      options,
      contextWindowTokens: contextWindow,
      reservedOutputTokens: outputReserve,
    }),
  );
  return requireAdmissibleTokenAccounting(result);
}

function compactionMapReduceTopology(
  leaves: number,
  fanIn = MAX_COMPACTION_FAN_IN,
): {
  readonly levels: number;
  readonly calls: number;
  readonly reductionChildReferences: number;
} {
  if (!Number.isSafeInteger(leaves) || leaves < 1) {
    throw new TypeError("compaction topology requires at least one leaf");
  }
  if (!Number.isSafeInteger(fanIn) || fanIn < 2 || fanIn > MAX_COMPACTION_FAN_IN) {
    throw new TypeError("compaction topology fan-in is outside its frozen bound");
  }
  let levelWidth = leaves;
  let levels = 1;
  let calls = leaves;
  let childReferences = 0;
  while (levelWidth > 1) {
    childReferences = safeSum(childReferences, levelWidth);
    const fullGroups = Math.floor(levelWidth / fanIn);
    const remainder = levelWidth % fanIn;
    const reductionCalls =
      levelWidth <= fanIn
        ? 1
        : fullGroups + (remainder > 1 ? 1 : 0);
    levelWidth = reductionCalls + (remainder === 1 ? 1 : 0);
    calls = safeSum(calls, reductionCalls);
    levels += 1;
  }
  return { levels, calls, reductionChildReferences: childReferences };
}

function messageForDigest(message: RuntimeMessage): unknown {
  return {
    role: roleOf(message),
    content: fromRuntimeMessageContent(
      message.content ?? message.message?.content ?? messageText(message),
    ),
    ...(message.toolCallId !== undefined ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolName !== undefined ? { tool_name: message.toolName } : {}),
    ...(message.toolCalls !== undefined
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments ?? "",
          })),
        }
      : {}),
    ...(message.runtimeOnly?.toolResultIntegrity !== undefined
      ? { tool_result_integrity: message.runtimeOnly.toolResultIntegrity }
      : {}),
    ...(message.runtimeOnly?.agentInvocation !== undefined
      ? { agent_invocation: message.runtimeOnly.agentInvocation }
      : {}),
  };
}

function messagesForDigest(messages: readonly RuntimeMessage[]): readonly unknown[] {
  return messages.map(messageForDigest);
}

export function canonicalCompactionSourceMessages(
  messages: readonly RuntimeMessage[],
): readonly unknown[] {
  return messagesForDigest(messages);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function safeSum(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < left) {
    throw new CompactionCannotReduceError("plan_limit", "compaction budget overflow");
  }
  return sum;
}
