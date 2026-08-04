import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { AdmissionDeniedError } from "../../budget/admission-client.js";
import { runAdmittedModelCall } from "../../budget/admitted-model-call.js";
import {
  createTokenAccountingRequest,
  requireAdmissibleTokenAccounting,
  assertTokenAccountingWithinContext,
  tokenAccountingService,
  type TokenAccountingResult,
} from "../../llm/token-accounting.js";
import {
  readProviderFactoryOptions,
  readProviderIdentity,
} from "../../llm/provider.js";
import type { LLMChatOptions, LLMMessage } from "../../llm/types.js";
import {
  accountCompactionCall,
  buildCompactionMapReducePlan,
  canonicalCompactionSourceMessages,
  structuredReductionMessages,
  type CompactionMapReducePlan,
} from "./plan.js";
import { getCompactionSystemPrompt } from "./prompt.js";
import {
  canonicalizeJson,
  createCompactionSummaryV1,
  digestWithDomain,
  parseCompactionBodyV1,
  sha256Hex,
  validateCompactionProvenance,
} from "./summary-v1.js";
import {
  COMPACTION_ACCOUNTING_DIGEST_DOMAIN,
  COMPACTION_CONFIGURATION_DIGEST_DOMAIN,
  COMPACTION_CONTEXT_KIND_V1,
  COMPACTION_EVENT_FORMAT_VERSION,
  COMPACTION_MINIMUM_READER_RUNTIME,
  COMPACTION_POLICY_DIGEST_DOMAIN,
  COMPACTION_SUMMARY_DAG_DIGEST_DOMAIN,
  MAX_COMPACTION_FOCUS_UTF8_BYTES,
  MAX_COMPACTION_INTERMEDIATE_TOKENS,
  MAX_COMPACTION_OUTPUT_NODES_TOTAL,
  MAX_COMPACTION_OUTPUT_UTF8_BYTES_TOTAL,
  MAX_COMPACTION_PROVIDER_CALLS,
  MAX_COMPACTION_SCHEMA_WORK_UNITS_PER_OUTPUT,
  MAX_COMPACTION_TOTAL_INPUT_TOKENS,
  MAX_COMPACTION_WALL_MS,
  MIN_COMPACTION_ABSOLUTE_TOKEN_SAVINGS,
  MIN_COMPACTION_RELATIVE_TOKEN_SAVINGS,
  type CompactionAccountingObservationV1,
  type CompactionFailureReason,
  type CompactionIntentV1,
  type CompactionProjectionMessageV1,
  type CompactionPreparedSourceV1,
  type CompactionSourceRefV1,
  type CompactionStage,
  type CompactionSummaryRefV1,
  type CompactionSummaryDagV1,
  type CompactionSummaryV1,
  type CompactionToolPairV1,
  type CompactionTransactionAdapter,
  type CompactionTransactionMetadataV1,
  CompactionCannotReduceError,
  CompactionReconstructionRequiredError,
  CompactionTransactionError,
} from "./transaction-types.js";
import type { CompactContext, CompactionResult, RuntimeMessage } from "./types.js";
import { estimateMessagesTokens } from "./_deps/runtime.js";
import { COMPACTION_HISTORY_MARKER_VERSION } from "../../session/compaction-history-marker.js";

const COMPACTION_BOUNDARY_MESSAGE = "Conversation compacted transactionally";
const COMPACTION_UNKNOWN_MODEL = "unknown";
const COMPACTION_DETAIL_DIGEST_DOMAIN = "agenc.compaction-failure.v1\0";

interface SummaryNode {
  readonly ref: CompactionSummaryRefV1;
  readonly summary: CompactionSummaryV1;
  readonly toolPairs: readonly CompactionToolPairV1[];
}

interface OutputTotals {
  bytes: number;
  nodes: number;
  workUnits: number;
}

export interface TransactionalCompactionOptions {
  readonly customInstructions: string;
  readonly direction?: "from" | "up_to";
  readonly automatic: boolean;
  readonly messagesToKeep: readonly RuntimeMessage[];
  readonly completeSourceMessages: readonly RuntimeMessage[];
  readonly messagesToSummarize: readonly RuntimeMessage[];
  readonly summaryPlacement: "before_keep" | "after_keep";
  readonly createBoundaryMarker: () => RuntimeMessage;
  readonly createSummaryMessage: (summary: string) => RuntimeMessage;
}

interface CompactionDeadline {
  readonly context: CompactContext;
  assertActive(): void;
  wait<T>(work: Promise<T>): Promise<T>;
  dispose(): void;
}

export function readCompactionTransactionAdapter(
  context: CompactContext,
): CompactionTransactionAdapter | undefined {
  const direct = context.compactionTransaction;
  if (direct !== undefined) return direct;
  const candidate = (context as CompactContext & {
    readonly rolloutStore?: unknown;
  }).rolloutStore;
  if (candidate === null || typeof candidate !== "object") return undefined;
  const adapter = candidate as Partial<CompactionTransactionAdapter>;
  const methods: ReadonlyArray<keyof CompactionTransactionAdapter> = [
    "prepareSource",
    "failureCount",
    "pinAndRecordIntent",
    "recordFailure",
    "commit",
    "markProjectionComplete",
    "markProjectionFailed",
    "markCleanupComplete",
    "markCleanupPending",
  ];
  if (methods.some((name) => typeof adapter[name] !== "function")) return undefined;
  if (typeof adapter.sessionId !== "string" || !Number.isSafeInteger(adapter.epoch)) {
    return undefined;
  }
  return adapter as CompactionTransactionAdapter;
}

export async function compactConversationTransactionally(
  context: CompactContext,
  options: TransactionalCompactionOptions,
): Promise<CompactionResult> {
  const deadline = createCompactionDeadline(context);
  try {
    return await compactConversationTransactionBody(
      deadline.context,
      options,
      deadline,
    );
  } finally {
    deadline.dispose();
  }
}

async function compactConversationTransactionBody(
  context: CompactContext,
  options: TransactionalCompactionOptions,
  deadline: CompactionDeadline,
): Promise<CompactionResult> {
  deadline.assertActive();
  const adapter = readCompactionTransactionAdapter(context);
  if (adapter === undefined) {
    throw new CompactionTransactionError(
      "pin_failed",
      "durable compaction transaction adapter is unavailable",
    );
  }
  const provider = context.provider;
  const session = context.admissionSession;
  if (provider === undefined) {
    throw new CompactionTransactionError(
      "provider_unavailable",
      "transactional compaction requires a provider response",
    );
  }
  if (session === undefined) {
    throw new CompactionTransactionError(
      "provider_unavailable",
      "transactional compaction requires an admission session",
    );
  }
  if (session.services.executionAdmission === undefined) {
    throw new CompactionTransactionError(
      "provider_unavailable",
      "transactional compaction requires an execution-admission client",
    );
  }

  const startedAt = performance.now();
  const attemptId = `compact-${randomUUID()}`;
  const direction = options.direction ?? "from";
  if (
    Buffer.byteLength(options.customInstructions, "utf8") >
    MAX_COMPACTION_FOCUS_UTF8_BYTES
  ) {
    throw new CompactionTransactionError(
      "source_limit_exceeded",
      `compaction coverage priority exceeds ${MAX_COMPACTION_FOCUS_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  const providerName = readProviderIdentity(provider) ?? provider.name;
  const providerOptions = readProviderFactoryOptions(provider);
  const model =
    context.options?.mainLoopModel ??
    providerOptions.model ??
    session.modelInfo.slug ??
    COMPACTION_UNKNOWN_MODEL;
  const policyMaterial = {
    map: getCompactionSystemPrompt("map", direction),
    reduce: getCompactionSystemPrompt("reduce", direction),
    final: getCompactionSystemPrompt("final", direction),
  } as const;
  const policyDigest = digestWithDomain(
    COMPACTION_POLICY_DIGEST_DOMAIN,
    policyMaterial,
  );
  const configurationDigest = digestWithDomain(
    COMPACTION_CONFIGURATION_DIGEST_DOMAIN,
    {
      model,
      provider: providerName,
      context_window_tokens: context.options?.contextWindowTokens ?? null,
      max_output_tokens: context.options?.maxOutputTokens ?? null,
      direction,
      requested_focus: options.customInstructions,
    },
  );
  const prepared = adapter.prepareSource(
    attemptId,
    options.completeSourceMessages,
  );
  deadline.assertActive();
  const historyDigest = prepared.source.history_digest;
  const accountingRef = digestWithDomain(
    COMPACTION_ACCOUNTING_DIGEST_DOMAIN,
    { history_digest: historyDigest, policy_digest: policyDigest, configuration_digest: configurationDigest },
  );
  const failures = adapter.failureCount(historyDigest, configurationDigest);
  if (options.automatic && failures >= 2) {
    throw new CompactionCannotReduceError(
      "failure_guard",
      "automatic compaction is suppressed after two durable failures for this history/configuration; change history or request an explicit manual retry",
    );
  }
  const mapSelection = createAuthoritativeSelectionMapper(
    options.completeSourceMessages,
    prepared,
  );
  const selected = mapSelection(options.messagesToSummarize);
  mapSelection(options.messagesToKeep);
  const selectedIndexes = new Set(selected.preparedIndexes);
  const authoritativeKeep = prepared.messages.filter(
    (_, index) => !selectedIndexes.has(index),
  );
  const plan = buildCompactionMapReducePlan(selected.messages, {
    context,
    source: prepared.source,
    systemPrompts: policyMaterial,
    requestedFocus: options.customInstructions,
    providerName,
    model,
    messageSourceRefs: selected.sourceRefs,
  });
  deadline.assertActive();
  const intentAtMs = Date.now();
  const intent: CompactionIntentV1 = {
    format_version: COMPACTION_EVENT_FORMAT_VERSION,
    minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
    attempt_id: attemptId,
    recorded_at_ms: intentAtMs,
    source: prepared.source,
    policy_digest: policyDigest,
    configuration_digest: configurationDigest,
    accounting_ref: accountingRef,
    automatic: options.automatic,
    selected_history_indexes: selected.preparedIndexes,
    admission_required: true,
    planned_provider_calls: plan.planned_provider_calls,
  };

  let intentCommitted = false;
  let transactionCommitted = false;
  try {
    adapter.pinAndRecordIntent(intent);
    intentCommitted = true;
    deadline.assertActive();
    const run = await deadline.wait(runSummaryTree({
      context,
      plan,
      attemptId,
      policyDigest,
      accountingRef,
      policyMaterial,
      requestedFocus: options.customInstructions,
      providerName,
      model,
      startedAt,
    }));
    deadline.assertActive();
    const narrative = renderSummaryBody(run.finalSummary);
    const rawBoundaryMarker = options.createBoundaryMarker();
    const rawSummaryMessage = options.createSummaryMessage(
      canonicalizeJson({
        version: 1,
        kind: COMPACTION_CONTEXT_KIND_V1,
        trust: "untrusted_historical_data",
        summary_sha256: run.finalSummary.summary_sha256,
        body: run.finalSummary.body,
      }),
    );
    const historyMarkerBase = {
      version: COMPACTION_HISTORY_MARKER_VERSION,
      attempt_id: attemptId,
      summary_sha256: run.finalSummary.summary_sha256,
    } as const;
    const boundaryMarker: RuntimeMessage = {
      ...rawBoundaryMarker,
      runtimeOnly: {
        ...rawBoundaryMarker.runtimeOnly,
        compactionHistory: { ...historyMarkerBase, kind: "boundary" },
      },
    };
    const summaryMessage: RuntimeMessage = {
      ...rawSummaryMessage,
      runtimeOnly: {
        ...rawSummaryMessage.runtimeOnly,
        compactionHistory: { ...historyMarkerBase, kind: "summary" },
      },
    };
    const attachments =
      (await deadline.wait(Promise.resolve(
        context.deps?.createAttachments?.(
          prepared.messages,
          context,
        ) ?? [],
      ))) ?? [];
    const hookResults =
      (await deadline.wait(Promise.resolve(
        context.deps?.createHookResults?.(narrative, context) ?? [],
      ))) ?? [];
    deadline.assertActive();
    const candidateResult: CompactionResult = {
      boundaryMarker,
      summaryMessages:
        options.summaryPlacement === "before_keep" ? [summaryMessage] : [],
      messagesToKeep:
        options.summaryPlacement === "after_keep"
          ? [...authoritativeKeep, summaryMessage]
          : authoritativeKeep,
      attachments,
      hookResults,
      userDisplayMessage: COMPACTION_BOUNDARY_MESSAGE,
    };
    const replacementSegment = [
      candidateResult.boundaryMarker,
      summaryMessage,
      ...candidateResult.attachments,
      ...candidateResult.hookResults,
    ];
    const firstSelectedIndex = Math.min(...selected.preparedIndexes);
    const replacementRuntime: RuntimeMessage[] = [];
    for (let index = 0; index < prepared.messages.length; index += 1) {
      if (index === firstSelectedIndex) {
        replacementRuntime.push(...replacementSegment);
      }
      if (!selectedIndexes.has(index)) {
        replacementRuntime.push(prepared.messages[index]!);
      }
    }
    const shrink = await deadline.wait(validateShrink({
      context,
      sourceMessages: prepared.messages,
      candidateMessages: replacementRuntime,
      providerName,
      model,
      accountingRef,
    }));
    deadline.assertActive();
    const committed = adapter.commit({
      intent,
      summary: run.finalSummary,
      summary_dag: run.summaryDag,
      accounting: shrink.observation,
      replacement_history: replacementRuntime.map(toProjectionMessage),
      committed_at_ms: Date.now(),
    });
    transactionCommitted = true;
    const transaction: CompactionTransactionMetadataV1 = {
      attempt_id: attemptId,
      history_digest: historyDigest,
      configuration_digest: configurationDigest,
      committed,
    };
    return {
      ...candidateResult,
      preCompactTokenCount: shrink.source.inputTokens,
      postCompactTokenCount: shrink.candidate.inputTokens,
      truePostCompactTokenCount: shrink.candidate.inputTokens,
      transaction,
    };
  } catch (error) {
    if (
      transactionCommitted ||
      !intentCommitted ||
      error instanceof CompactionReconstructionRequiredError
    ) {
      throw error;
    }
    const reason = classifyFailure(error, context);
    const failedAt = Date.now();
    const failure = {
      format_version: COMPACTION_EVENT_FORMAT_VERSION,
      minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
      attempt_id: attemptId,
      recorded_at_ms: failedAt,
      source_sha256: prepared.source.source_sha256,
      history_digest: historyDigest,
      reason,
      detail_digest: sha256Hex(
        `${COMPACTION_DETAIL_DIGEST_DOMAIN}${errorDetail(error)}`,
      ),
    } as const;
    try {
      adapter.recordFailure(failure);
    } catch (recordError) {
      throw new CompactionTransactionError(
        reason,
        "compaction failed and its terminal failure event could not be committed; source remains pinned for startup reconciliation",
        { cause: new AggregateError([error, recordError]) },
      );
    }
    throw error;
  }
}

async function runSummaryTree(params: {
  readonly context: CompactContext;
  readonly plan: CompactionMapReducePlan;
  readonly attemptId: string;
  readonly policyDigest: string;
  readonly accountingRef: string;
  readonly policyMaterial: Readonly<Record<CompactionStage, string>>;
  readonly requestedFocus: string;
  readonly providerName: string;
  readonly model: string;
  readonly startedAt: number;
}): Promise<{
  readonly finalSummary: CompactionSummaryV1;
  readonly summaryDag: CompactionSummaryDagV1;
}> {
  const summaries = new Map<string, CompactionSummaryV1>();
  const allowedChildren = new Map<string, ReadonlySet<string>>();
  const totals: OutputTotals = { bytes: 0, nodes: 0, workUnits: 0 };
  let callCount = 0;
  let inputTokens = 0;
  const call = async (
    stage: CompactionStage,
    messages: readonly LLMMessage[],
    sourceRefs: readonly CompactionSourceRefV1[],
    expectedToolPairs: readonly CompactionToolPairV1[],
  ): Promise<SummaryNode> => {
    callCount += 1;
    if (
      callCount > params.plan.planned_provider_calls ||
      callCount > MAX_COMPACTION_PROVIDER_CALLS
    ) {
      throw new CompactionTransactionError(
        "plan_limit_exceeded",
        "runtime compaction call count exceeded its preflight plan",
      );
    }
    const plannedCall = params.plan.calls[callCount - 1];
    if (
      plannedCall === undefined ||
      plannedCall.stage !== stage ||
      plannedCall.source_ref_ids.length !== sourceRefs.length ||
      plannedCall.source_ref_ids.some(
        (id, index) => id !== sourceRefs[index]?.ref_id,
      )
    ) {
      throw new CompactionTransactionError(
        "plan_limit_exceeded",
        "runtime compaction call diverged from the frozen preflight DAG",
      );
    }
    if (performance.now() - params.startedAt > MAX_COMPACTION_WALL_MS) {
      throw new CompactionTransactionError(
        "wall_time_exceeded",
        "compaction exceeded its wall-clock budget",
      );
    }
    accountCompactionCall({
      messages,
      systemPrompt: params.policyMaterial[stage],
      providerName: params.providerName,
      model: params.model,
      contextWindowTokens: params.plan.context_window_tokens,
      outputReserveTokens: params.plan.output_reserve_tokens,
    });
    const invocation = await invokeCompactionProvider({
      context: params.context,
      messages,
      systemPrompt: params.policyMaterial[stage],
      providerName: params.providerName,
      model: params.model,
      callCount,
      attemptId: params.attemptId,
      contextWindowTokens: params.plan.context_window_tokens,
      outputReserveTokens: params.plan.output_reserve_tokens,
      remainingInputTokens: MAX_COMPACTION_TOTAL_INPUT_TOKENS - inputTokens,
    });
    inputTokens = safeBudgetSum(
      inputTokens,
      invocation.accounting.inputTokens,
    );
    if (inputTokens > MAX_COMPACTION_TOTAL_INPUT_TOKENS) {
      throw new CompactionTransactionError(
        "token_budget_exceeded",
        "exact provider token counts exceeded the aggregate compaction budget",
      );
    }
    const response = invocation.response;
    if (response.finishReason !== "stop") {
      throw new CompactionTransactionError(
        "provider_non_stop",
        `compaction provider finish reason was ${response.finishReason}`,
      );
    }
    if (response.content.trim().length === 0) {
      throw new CompactionTransactionError(
        "provider_empty",
        "compaction provider returned an empty body",
      );
    }
    if (
      compactionOutputTokenUpperBound(
        response.content,
        response.usage?.completionTokens,
      ) > params.plan.output_reserve_tokens
    ) {
      throw new CompactionTransactionError(
        "output_limit_exceeded",
        "compaction provider exceeded the intermediate-token limit",
      );
    }
    const allowedIds = new Set(sourceRefs.map((ref) => ref.ref_id));
    const validated = parseCompactionBodyV1(response.content, allowedIds);
    assertExactToolPairs(validated.body.tool_pairs, expectedToolPairs);
    totals.bytes = safeBudgetSum(totals.bytes, validated.budget.bytes);
    totals.nodes = safeBudgetSum(totals.nodes, validated.budget.nodes);
    totals.workUnits = safeBudgetSum(
      totals.workUnits,
      validated.budget.workUnits,
    );
    if (
      totals.bytes > MAX_COMPACTION_OUTPUT_UTF8_BYTES_TOTAL ||
      totals.nodes > MAX_COMPACTION_OUTPUT_NODES_TOTAL ||
      totals.workUnits >
        MAX_COMPACTION_SCHEMA_WORK_UNITS_PER_OUTPUT * MAX_COMPACTION_PROVIDER_CALLS
    ) {
      throw new CompactionTransactionError(
        "output_limit_exceeded",
        "compaction provider outputs exceeded an aggregate limit",
      );
    }
    const summary = createCompactionSummaryV1({
      stage,
      attemptId: params.attemptId,
      policyDigest: params.policyDigest,
      accountingRef: params.accountingRef,
      sourceRefs,
      body: validated.body,
    });
    const ref: CompactionSummaryRefV1 = {
      kind: "compaction_summary",
      ref_id: plannedCall.result_ref_id,
      sha256: summary.summary_sha256,
    };
    summaries.set(ref.ref_id, summary);
    allowedChildren.set(ref.ref_id, allowedIds);
    return { ref, summary, toolPairs: expectedToolPairs };
  };

  let level: SummaryNode[];
  if (params.plan.chunks.length === 1) {
    const only = params.plan.chunks[0]!;
    const final = await call(
      "final",
      only.messages,
      [only.source_ref],
      only.tool_pairs,
    );
    validateCompactionProvenance({
      final: final.summary,
      summariesById: summaries,
      plannedLeaves: params.plan.leaf_refs,
      allowedChildrenBySummaryId: allowedChildren,
    });
    return {
      finalSummary: final.summary,
      summaryDag: createSummaryDag(params.plan, summaries, final.ref.ref_id),
    };
  }
  level = [];
  for (const chunk of params.plan.chunks) {
    level.push(
      await call("map", chunk.messages, [chunk.source_ref], chunk.tool_pairs),
    );
  }
  while (level.length > params.plan.reduction_fan_in) {
    const reduced: SummaryNode[] = [];
    for (let index = 0; index < level.length; index += params.plan.reduction_fan_in) {
      const group = level.slice(index, index + params.plan.reduction_fan_in);
      if (group.length === 1) {
        reduced.push(group[0]!);
        continue;
      }
      const refs = group.map((node) => node.ref);
      reduced.push(
        await call(
          "reduce",
          structuredReductionMessages({
            children: group.map((node) => ({
              ref_id: node.ref.ref_id,
              sha256: node.ref.sha256,
              body: node.summary.body,
            })),
            stage: "reduce",
            requestedFocus: params.requestedFocus,
          }),
          refs,
          group.flatMap((node) => node.toolPairs),
        ),
      );
    }
    level = reduced;
  }
  const final = await call(
    "final",
    structuredReductionMessages({
      children: level.map((node) => ({
        ref_id: node.ref.ref_id,
        sha256: node.ref.sha256,
        body: node.summary.body,
      })),
      stage: "final",
      requestedFocus: params.requestedFocus,
    }),
    level.map((node) => node.ref),
    level.flatMap((node) => node.toolPairs),
  );
  validateCompactionProvenance({
    final: final.summary,
    summariesById: summaries,
    plannedLeaves: params.plan.leaf_refs,
    allowedChildrenBySummaryId: allowedChildren,
  });
  return {
    finalSummary: final.summary,
    summaryDag: createSummaryDag(params.plan, summaries, final.ref.ref_id),
  };
}

function createSummaryDag(
  plan: CompactionMapReducePlan,
  summaries: ReadonlyMap<string, CompactionSummaryV1>,
  finalRefId: string,
): CompactionSummaryDagV1 {
  const withoutDigest = {
    reduction_fan_in: plan.reduction_fan_in,
    maximum_levels: plan.maximum_levels,
    planned_provider_calls: plan.planned_provider_calls,
    leaf_plan: plan.chunks.map((chunk) => ({
      source_ref: chunk.source_ref,
      tool_pairs: chunk.tool_pairs,
    })),
    intermediate_summaries: [...summaries.entries()]
      .filter(([refId]) => refId !== finalRefId)
      .map(([refId, summary]) => ({
        ref: {
          kind: "compaction_summary" as const,
          ref_id: refId,
          sha256: summary.summary_sha256,
        },
        summary,
      })),
  } as const;
  return {
    ...withoutDigest,
    dag_sha256: digestWithDomain(
      COMPACTION_SUMMARY_DAG_DIGEST_DOMAIN,
      withoutDigest,
    ),
  };
}

/**
 * A tokenizer can emit at most one token per UTF-8 byte. Provider usage is
 * authoritative when present; otherwise the byte length is a deliberately
 * conservative upper bound that keeps the pre-parse output cap enforceable.
 */
export function compactionOutputTokenUpperBound(
  content: string,
  reportedCompletionTokens: number | undefined,
): number {
  const utf8UpperBound = Buffer.byteLength(content, "utf8");
  if (
    reportedCompletionTokens !== undefined &&
    Number.isSafeInteger(reportedCompletionTokens) &&
    reportedCompletionTokens >= 0
  ) {
    return Math.max(reportedCompletionTokens, utf8UpperBound);
  }
  return utf8UpperBound;
}

function assertExactToolPairs(
  actual: readonly CompactionToolPairV1[],
  expected: readonly CompactionToolPairV1[],
): void {
  if (
    actual.length !== expected.length ||
    actual.some(
      (pair, index) =>
        pair.tool_call_id !== expected[index]?.tool_call_id ||
        pair.result_sha256 !== expected[index]?.result_sha256,
    )
  ) {
    throw new CompactionTransactionError(
      "provenance_invalid",
      "compaction summary omitted, forged, duplicated, or reordered an immutable tool call/result pair",
    );
  }
}

async function invokeCompactionProvider(params: {
  readonly context: CompactContext;
  readonly messages: readonly LLMMessage[];
  readonly systemPrompt: string;
  readonly providerName: string;
  readonly model: string;
  readonly callCount: number;
  readonly attemptId: string;
  readonly contextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly remainingInputTokens: number;
}) {
  const provider = params.context.provider!;
  const session = params.context.admissionSession!;
  const signal = params.context.abortController?.signal;
  const options: LLMChatOptions = {
    model: params.model,
    systemPrompt: params.systemPrompt,
    maxOutputTokens: params.outputReserveTokens,
    contextWindowTokens: params.contextWindowTokens,
    ...(signal !== undefined ? { signal } : {}),
  };
  const request = createTokenAccountingRequest({
    provider: params.providerName,
    model: params.model,
    messages: [...params.messages],
    options,
    contextWindowTokens: params.contextWindowTokens,
    reservedOutputTokens: params.outputReserveTokens,
  });
  const exactAccounting = requireAdmissibleTokenAccounting(
    await tokenAccountingService.count(request, {
      capability: provider.tokenCountCapability,
      ...(signal !== undefined ? { signal } : {}),
    }),
  );
  assertTokenAccountingWithinContext(
    exactAccounting,
    params.contextWindowTokens,
  );
  if (exactAccounting.inputTokens > params.remainingInputTokens) {
    throw new CompactionTransactionError(
      "token_budget_exceeded",
      "exact provider token count exceeds the remaining aggregate compaction budget",
    );
  }
  const response = await runAdmittedModelCall({
    session,
    provider,
    messages: [...params.messages],
    options,
    stepId: `compact:${params.attemptId}:${params.callCount}`,
    sessionId: session.conversationId,
    model: params.model,
    providerName: params.providerName,
    ...(signal !== undefined ? { signal } : {}),
    invoke: (admittedOptions) => provider.chat([...params.messages], admittedOptions),
  });
  return { response, accounting: exactAccounting };
}

async function validateShrink(params: {
  readonly context: CompactContext;
  readonly sourceMessages: readonly RuntimeMessage[];
  readonly candidateMessages: readonly RuntimeMessage[];
  readonly providerName: string;
  readonly model: string;
  readonly accountingRef: string;
}): Promise<{
  readonly source: TokenAccountingResult;
  readonly candidate: TokenAccountingResult;
  readonly observation: CompactionAccountingObservationV1;
}> {
  const contextWindow = params.context.options?.contextWindowTokens ?? 128_000;
  const outputReserve = Math.min(
    params.context.options?.maxOutputTokens ?? 4_000,
    MAX_COMPACTION_INTERMEDIATE_TOKENS,
  );
  const baseOptions: LLMChatOptions = {
    model: params.model,
    systemPrompt: params.context.options?.systemPrompt ?? "",
    maxOutputTokens: outputReserve,
    contextWindowTokens: contextWindow,
    ...(params.context.options?.tools !== undefined
      ? { tools: params.context.options.tools }
      : {}),
    ...(params.context.options?.toolChoice !== undefined
      ? { toolChoice: params.context.options.toolChoice }
      : {}),
  };
  const count = async (messages: readonly RuntimeMessage[]) => {
    const request = createTokenAccountingRequest({
      provider: params.providerName,
      model: params.model,
      messages: messages.map(toLlmMessage),
      options: baseOptions,
      contextWindowTokens: contextWindow,
      reservedOutputTokens: outputReserve,
    });
    return requireAdmissibleTokenAccounting(
      await tokenAccountingService.count(request, {
        capability: params.context.provider?.tokenCountCapability,
        ...(params.context.abortController?.signal !== undefined
          ? { signal: params.context.abortController.signal }
          : {}),
      }),
    );
  };
  const [source, candidate] = await Promise.all([
    count(params.sourceMessages),
    count(params.candidateMessages),
  ]);
  assertTokenAccountingWithinContext(candidate, contextWindow);
  const savings = source.inputTokens - candidate.inputTokens;
  const relativeSavings = source.inputTokens === 0 ? 0 : savings / source.inputTokens;
  if (
    savings < MIN_COMPACTION_ABSOLUTE_TOKEN_SAVINGS ||
    relativeSavings < MIN_COMPACTION_RELATIVE_TOKEN_SAVINGS
  ) {
    throw new CompactionCannotReduceError(
      "no_shrink",
      `compaction candidate saves ${savings} tokens (${relativeSavings.toFixed(3)}); required ${MIN_COMPACTION_ABSOLUTE_TOKEN_SAVINGS} and ${MIN_COMPACTION_RELATIVE_TOKEN_SAVINGS}`,
    );
  }
  return {
    source,
    candidate,
    observation: {
      accounting_ref: params.accountingRef,
      source_tokens: source.inputTokens,
      candidate_tokens: candidate.inputTokens,
      context_window_tokens: contextWindow,
      reserved_output_tokens: outputReserve,
      source: candidate.source,
      confidence: candidate.confidence,
    },
  };
}

function renderSummaryBody(summary: CompactionSummaryV1): string {
  const sections = [summary.body.narrative.trim()];
  if (summary.body.facts.length > 0) {
    sections.push(
      `Facts:\n${summary.body.facts.map((fact) => `- ${fact.text}`).join("\n")}`,
    );
  }
  if (summary.body.open_actions.length > 0) {
    sections.push(
      `Open actions:\n${summary.body.open_actions
        .map((action) => `- ${action.text}`)
        .join("\n")}`,
    );
  }
  if (summary.body.tool_pairs.length > 0) {
    sections.push(
      `Tool result integrity:\n${summary.body.tool_pairs
        .map((pair) => `- ${pair.tool_call_id}: sha256:${pair.result_sha256}`)
        .join("\n")}`,
    );
  }
  return sections.filter((section) => section.length > 0).join("\n\n");
}

function toProjectionMessage(message: RuntimeMessage): CompactionProjectionMessageV1 {
  const role = message.originalRole ?? message.role ?? message.message?.role ?? "user";
  const normalizedRole = role === "developer" ? "developer" : role;
  if (!["system", "developer", "user", "assistant", "tool"].includes(normalizedRole)) {
    throw new CompactionTransactionError(
      "output_schema_invalid",
      `unsupported replacement-history role ${normalizedRole}`,
    );
  }
  const content = message.content ?? message.message?.content ?? "";
  if (typeof content !== "string" && !Array.isArray(content)) {
    throw new CompactionTransactionError(
      "output_schema_invalid",
      "replacement-history content is not persistable",
    );
  }
  return {
    role: normalizedRole as CompactionProjectionMessageV1["role"],
    content: content as CompactionProjectionMessageV1["content"],
    ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.uuid !== undefined ? { id: message.uuid } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
    ...(message.runtimeOnly?.toolResultIntegrity !== undefined
      ? {
          toolResultIntegrity: {
            ...message.runtimeOnly.toolResultIntegrity,
          },
        }
      : {}),
    ...(message.runtimeOnly?.agentInvocation !== undefined
      ? { agentInvocation: { ...message.runtimeOnly.agentInvocation } }
      : {}),
    ...(message.runtimeOnly?.compactionHistory !== undefined
      ? { compactionHistory: { ...message.runtimeOnly.compactionHistory } }
      : {}),
  };
}

function toLlmMessage(message: RuntimeMessage): LLMMessage {
  const projected = toProjectionMessage(message);
  return {
    role: projected.role,
    content: typeof projected.content === "string"
      ? projected.content
      : projected.content.map((part) => ({ ...part })) as LLMMessage["content"],
    ...(projected.toolCalls !== undefined
      ? {
          toolCalls: projected.toolCalls.map((call) => ({
            ...call,
            arguments: call.arguments ?? "",
          })),
        }
      : {}),
    ...(projected.toolCallId !== undefined ? { toolCallId: projected.toolCallId } : {}),
    ...(projected.toolName !== undefined ? { toolName: projected.toolName } : {}),
    ...(projected.compactionHistory !== undefined
      ? { runtimeOnly: { compactionHistory: projected.compactionHistory } }
      : {}),
  };
}

function createAuthoritativeSelectionMapper(
  callerComplete: readonly RuntimeMessage[],
  prepared: CompactionPreparedSourceV1,
): (selected: readonly RuntimeMessage[]) => {
  readonly messages: readonly RuntimeMessage[];
  readonly sourceRefs: readonly Extract<CompactionSourceRefV1, { readonly kind: "rollout_span" }>[];
  readonly preparedIndexes: readonly number[];
} {
  const key = (message: RuntimeMessage): string =>
    canonicalizeJson(canonicalCompactionSourceMessages([message]));
  const preparedByKey = new Map<string, number[]>();
  prepared.messages.forEach((message, index) => {
    const messageKey = key(message);
    const positions = preparedByKey.get(messageKey);
    if (positions === undefined) preparedByKey.set(messageKey, [index]);
    else positions.push(index);
  });
  const callerToPrepared: number[] = [];
  let nextPreparedIndex = prepared.messages.length;
  for (let callerIndex = callerComplete.length - 1; callerIndex >= 0; callerIndex -= 1) {
    const message = callerComplete[callerIndex]!;
    const positions = preparedByKey.get(key(message)) ?? [];
    const positionIndex = lastIndexLessThan(positions, nextPreparedIndex);
    if (positionIndex < 0) {
      throw new CompactionTransactionError(
        "pin_failed",
        "caller history is not an ordered projection of canonical active history",
      );
    }
    nextPreparedIndex = positions[positionIndex]!;
    callerToPrepared[callerIndex] = nextPreparedIndex;
  }

  const callerIdentity = new Map<RuntimeMessage, number[]>();
  const callerByKey = new Map<string, number[]>();
  callerComplete.forEach((message, index) => {
    const identityPositions = callerIdentity.get(message);
    if (identityPositions === undefined) callerIdentity.set(message, [index]);
    else identityPositions.push(index);
    const messageKey = key(message);
    const keyPositions = callerByKey.get(messageKey);
    if (keyPositions === undefined) callerByKey.set(messageKey, [index]);
    else keyPositions.push(index);
  });

  return (selected) => {
    const used = new Set<number>();
    const cursorByKey = new Map<string, number>();
    const cursorByIdentity = new Map<RuntimeMessage, number>();
    const callerIndexes = selected.map((message) => {
      const identityPositions = callerIdentity.get(message) ?? [];
      let identityCursor = cursorByIdentity.get(message) ?? 0;
      while (used.has(identityPositions[identityCursor]!)) identityCursor += 1;
      let callerIndex = identityPositions[identityCursor];
      if (callerIndex !== undefined) {
        cursorByIdentity.set(message, identityCursor + 1);
      } else {
        const messageKey = key(message);
        const keyPositions = callerByKey.get(messageKey) ?? [];
        let keyCursor = cursorByKey.get(messageKey) ?? 0;
        while (used.has(keyPositions[keyCursor]!)) keyCursor += 1;
        callerIndex = keyPositions[keyCursor];
        if (callerIndex === undefined) {
          throw new CompactionTransactionError(
            "provenance_invalid",
            "selected compaction message has no canonical caller position",
          );
        }
        cursorByKey.set(messageKey, keyCursor + 1);
      }
      used.add(callerIndex);
      return callerIndex;
    });
    const preparedIndexes = callerIndexes.map((index) => callerToPrepared[index]!);
    return {
      messages: preparedIndexes.map((index) => prepared.messages[index]!),
      sourceRefs: preparedIndexes.map(
        (index) => prepared.message_source_refs[index]!,
      ),
      preparedIndexes,
    };
  };
}

function lastIndexLessThan(values: readonly number[], threshold: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle]! < threshold) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function classifyFailure(
  error: unknown,
  context: CompactContext,
): CompactionFailureReason {
  if (error instanceof CompactionTransactionError) return error.reason;
  if (error instanceof CompactionCannotReduceError) {
    if (error.code === "no_shrink") return "no_shrink";
    if (error.code === "semantic_unit_oversized") return "semantic_unit_oversized";
    if (error.code === "source_limit") return "source_limit_exceeded";
    if (error.code === "context_limit") return "token_budget_exceeded";
    return "plan_limit_exceeded";
  }
  if (context.abortController?.signal.aborted === true) return "aborted";
  if (error instanceof AdmissionDeniedError) return "provider_rate_limited";
  if (error instanceof Error) {
    if (error.name === "AbortError") return "aborted";
    const message = error.message.toLowerCase();
    if (message.includes("timeout")) return "provider_timeout";
    if (message.includes("rate") || message.includes("429")) {
      return "provider_rate_limited";
    }
  }
  return "provider_error";
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return `${error.name}:${error.message}`;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

function safeBudgetSum(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < left) {
    throw new CompactionTransactionError(
      "output_limit_exceeded",
      "compaction aggregate budget overflow",
    );
  }
  return sum;
}

function createCompactionDeadline(context: CompactContext): CompactionDeadline {
  const controller = new AbortController();
  const upstream = context.abortController?.signal;
  const abortFromUpstream = (): void => {
    controller.abort(
      upstream?.reason ?? new DOMException("Compaction aborted", "AbortError"),
    );
  };
  if (upstream?.aborted === true) abortFromUpstream();
  else upstream?.addEventListener("abort", abortFromUpstream, { once: true });
  const timer = setTimeout(() => {
    controller.abort(
      new CompactionTransactionError(
        "wall_time_exceeded",
        `compaction exceeded its ${MAX_COMPACTION_WALL_MS} ms wall-clock deadline`,
      ),
    );
  }, MAX_COMPACTION_WALL_MS);
  timer.unref();

  const assertActive = (): void => {
    if (!controller.signal.aborted) return;
    throw controller.signal.reason ?? new DOMException("Compaction aborted", "AbortError");
  };
  const wait = async <T>(work: Promise<T>): Promise<T> => {
    assertActive();
    return await new Promise<T>((resolve, reject) => {
      const aborted = (): void => reject(
        controller.signal.reason ??
          new DOMException("Compaction aborted", "AbortError"),
      );
      controller.signal.addEventListener("abort", aborted, { once: true });
      work.then(
        (value) => {
          controller.signal.removeEventListener("abort", aborted);
          resolve(value);
        },
        (error: unknown) => {
          controller.signal.removeEventListener("abort", aborted);
          reject(error);
        },
      );
    });
  };
  return {
    context: { ...context, abortController: controller },
    assertActive,
    wait,
    dispose: () => {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", abortFromUpstream);
    },
  };
}

/** Legacy display estimate retained only for non-transactional callers/tests. */
export function legacyCompactionEstimate(
  messages: readonly RuntimeMessage[],
  context: CompactContext,
): number {
  return estimateMessagesTokens(messages, context);
}
