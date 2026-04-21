/**
 * Phase 1 — Prepare Context.
 *
 * Mirrors openclaude `query.ts:311-652` — the staged pre-model-call
 * chain:
 *
 *   1. **Compact-boundary projection** — rebuild `messagesForQuery`
 *      from the slice AFTER the most recent compact-summary message
 *      in `state.messages` (`getMessagesAfterCompactBoundary` in
 *      openclaude). Implemented here in pure TS.
 *
 *   2. **Tool-result budgeting** (`applyToolResultBudget`) — per-tool
 *      result-size enforcement with optional persistence.
 *
 *   3. **Snip compaction** (`snipCompactIfNeeded`) — removes oversized
 *      tool-result bodies pre-autocompact.
 *
 *   4. **MicroCompact** (`microcompact`) — streaming micro-compaction.
 *
 *   5. **Context-collapse projection** (`applyCollapsesIfNeeded`) —
 *      idempotent view over the REPL's full history.
 *
 *   6. **AutoCompactIfNeeded** (`autoCompactIfNeeded`) — full-context
 *      compaction when token count crosses the threshold.
 *
 *   7. **Blocking-limit preempt** — hard fail when auto-compact is off
 *      and cumulative tokens cross the blocking limit.
 *
 * The compact-boundary projection is live in T5; the compaction
 * pipeline stages 2-7 call into `runtime/src/llm/compact/**` via
 * literal-path dynamic imports (`safeCompactImport`) so tsup traces
 * each stage module into the runtime bundle. I-18 is reachable
 * through stage 6 (`autoCompactIfNeeded` -> `compactConversation` ->
 * `assertCompactionShrank`), so a near-identity summary on the
 * autocompact path throws `CompactionShrinkRatioError`, which the
 * caller's catch uses to bump the
 * `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3` circuit breaker.
 *
 * Invariants wired:
 *   I-2  (clearResponseId on compact) — handled by
 *        post-compact-cleanup.ts via grok/incremental tracker registry.
 *   I-18 (compaction shrink assertion) — lives inside compact.ts.
 *   I-88 (per-turn toolResultBytes index) — T6 wires; no-op here.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import type { QuerySource } from "../constants/querySource.js";
import { calculateTokenWarningState, isAutoCompactEnabled } from "../llm/compact/auto-compact.js";
import {
  buildCompactedRolloutItem,
  buildPostCompactMessages,
} from "../llm/compact/compact.js";
import {
  buildCompactCacheSafeParams,
  createSessionBackedCompactContext,
} from "../llm/compact/runtime-context.js";
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from "../recovery/api-errors.js";
import type { Session } from "../session/session.js";
import type { Config, TurnContext } from "../session/turn-context.js";
import type {
  AssistantMessage,
  Terminal,
  TurnState,
} from "../session/turn-state.js";
import {
  finalContextTokensFromLastResponse,
  tokenCountWithEstimation,
} from "../utils/tokens.js";

/**
 * Dynamic loader for the compact/ subsystem. Each compact stage is
 * loaded through a literal-path dynamic `import()` so tsup/esbuild
 * traces the module into the runtime bundle (variable-path dynamic
 * imports are NOT traced). Result is `null` when the module tree
 * fails to resolve at runtime — callers treat that as "stage
 * disabled", matching openclaude's feature-off behavior.
 *
 * Historical: the previous `safeCompactRequire` helper silently
 * swallowed every load failure. That hid real module-evaluation
 * regressions (a compact stage throwing at import time looked
 * identical to a stage not yet wired). Runtime `MODULE_NOT_FOUND` /
 * `ERR_MODULE_NOT_FOUND` is the only benign failure mode here and is
 * still silent, because with literal dynamic imports those only fire
 * when the bundler genuinely did not trace the module (legitimate
 * "stage disabled"). Every other error path now emits
 * `warning:compact_stage_failed` so silent regressions can't hide.
 *
 * `stageLabel` is embedded in the emitted warning so operators can
 * see which compaction stage failed without decoding bundler paths.
 */
async function safeCompactImport<T = unknown>(
  stageLabel: "snip_compact" | "micro_compact" | "auto_compact",
  loader: () => Promise<unknown>,
  session?: Session,
): Promise<T | null> {
  try {
    const mod = await loader();
    return mod as T;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    // Expected when the bundler legitimately tree-shook this stage
    // (no import graph ties to it) — stays silent to avoid per-turn
    // warning spam.
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
      session?.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "compact_stage_failed",
            message: `compact stage ${stageLabel} failed to load: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        },
      });
    }
    return null;
  }
}

/**
 * Look backwards through `messages` for the most recent compact-
 * boundary marker. openclaude marks boundaries with a system-role
 * message carrying `isCompactSummary` / `isCompactBoundary`. AgenC's
 * LLMMessage doesn't carry that flag yet (T6 adds it with the real
 * rollout), so we detect the boundary by searching for an assistant
 * message whose content begins with a compact-summary marker token
 * or an anchor-preserved user message tagged with the compact
 * attachment kind. Returns the slice from the message AFTER the
 * boundary onward (or the full history when no boundary exists).
 *
 * Openclaude reference: `services/compact/grouping.ts` +
 * `utils/messages.ts::getMessagesAfterCompactBoundary`.
 */
const COMPACT_BOUNDARY_PREFIX = "<agenc-compact-boundary>";

function getMessagesAfterCompactBoundary(
  messages: ReadonlyArray<LLMMessage>,
): LLMMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m) continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (content.startsWith(COMPACT_BOUNDARY_PREFIX)) {
      return messages.slice(i + 1).map((x) => ({ ...x }));
    }
  }
  return messages.map((x) => ({ ...x }));
}

// ─────────────────────────────────────────────────────────────────────
// Stage 2 — tool-result budgeting (ports openclaude `query.ts:~369` →
// `toolResultStorage.ts::applyToolResultBudget`).
//
// Runs oldest → newest over the model-visible message slice and truncates
// tool-role message bodies with the I-15 marker (same text shape as
// `capToolResult` in `tools/execution.ts`) until the running byte total
// falls at or under `maxToolResultBudgetBytes`.
//
// Invariants:
//   - Message ordering is preserved (clone-in-place on hit, passthrough
//     on miss).
//   - Truncation marker matches I-15 so downstream consumers and
//     compaction passes see one consistent shape.
//   - Env overrides (`AGENC_TOOL_RESULT_BUDGET_BYTES`,
//     `AGENC_TOOL_RESULT_TRUNCATE_BYTES`) win over config knobs; config
//     knobs win over hard-coded openclaude defaults (2MB / 40KB).
// ─────────────────────────────────────────────────────────────────────

/** Openclaude parity defaults (toolResultStorage + constants/toolLimits). */
const DEFAULT_MAX_TOOL_RESULT_BUDGET_BYTES = 2 * 1024 * 1024; // 2 MB
const DEFAULT_TOOL_RESULT_TRUNCATE_BYTES = 40 * 1024; // 40 KB

/**
 * I-15 marker (keep in sync with `capToolResult` in
 * `runtime/src/tools/execution.ts`). Shared wording — do not fork.
 */
const STAGE2_TRUNCATION_MARKER_TEMPLATE =
  "\n\n[truncated: original was {ORIG} bytes, returning first {KEPT}]\n";

function readEnvBytes(name: string): number | undefined {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

/** Resolve the effective budget/truncation knobs (env > config > default). */
export function resolveToolBudgetConfig(
  config?: Pick<Config, "toolBudget">,
): {
  maxToolResultBudgetBytes: number;
  truncateToBytes: number;
} {
  const envBudget = readEnvBytes("AGENC_TOOL_RESULT_BUDGET_BYTES");
  const envTruncate = readEnvBytes("AGENC_TOOL_RESULT_TRUNCATE_BYTES");
  const cfg = config?.toolBudget;
  const maxToolResultBudgetBytes =
    envBudget ??
    (cfg?.maxToolResultBudgetBytes && cfg.maxToolResultBudgetBytes > 0
      ? cfg.maxToolResultBudgetBytes
      : DEFAULT_MAX_TOOL_RESULT_BUDGET_BYTES);
  const truncateToBytes =
    envTruncate ??
    (cfg?.truncateToBytes && cfg.truncateToBytes > 0
      ? cfg.truncateToBytes
      : DEFAULT_TOOL_RESULT_TRUNCATE_BYTES);
  return { maxToolResultBudgetBytes, truncateToBytes };
}

/**
 * Return the UTF-8 byte size of an `LLMMessage.content` (string or
 * multimodal content-part array). Text parts are summed; non-text parts
 * (image_url, etc.) are ignored — they don't participate in the
 * tool-result size budget (openclaude's `contentSize` parity).
 */
function messageContentBytes(content: LLMMessage["content"]): number {
  if (typeof content === "string") {
    return Buffer.byteLength(content, "utf8");
  }
  let total = 0;
  for (const part of content) {
    if (part.type === "text") {
      total += Buffer.byteLength(part.text, "utf8");
    }
  }
  return total;
}

/**
 * Truncate a tool-role message's text content to at most `targetBytes`
 * and append the I-15-style marker. Preserves multimodal part ordering
 * by collapsing text parts into a single capped string + marker; non-
 * text parts are dropped (they cannot meaningfully survive a byte-cap
 * on the tool-result channel).
 */
function truncateToolMessage(
  message: LLMMessage,
  originalBytes: number,
  targetBytes: number,
): LLMMessage {
  const marker = STAGE2_TRUNCATION_MARKER_TEMPLATE
    .replace("{ORIG}", String(originalBytes))
    .replace("{KEPT}", String(targetBytes));
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const keepBytes = Math.max(0, targetBytes - markerBytes);

  const flat =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("");
  const buf = Buffer.from(flat, "utf8");
  const kept = buf.subarray(0, keepBytes).toString("utf8");
  return { ...message, content: `${kept}${marker}` };
}

export interface ToolResultBudgetingResult {
  readonly messages: LLMMessage[];
  readonly bytesFreed: number;
  readonly truncatedCount: number;
}

/**
 * Apply Stage 2 tool-result budgeting. Iterates oldest → newest over
 * `messages`; for each `role:"tool"` entry whose byte-size exceeds
 * `truncateToBytes`, truncates with the I-15 marker and subtracts the
 * freed bytes from the running total. Halts early once the running
 * total is ≤ `maxToolResultBudgetBytes`.
 *
 * `toolResultBytesByTurn` is the I-88 per-turn index. When provided we
 * seed the running total from its aggregate sum (authoritative across
 * turns); otherwise we measure in-place. Ordering is always preserved.
 *
 * @param messages  The model-visible message slice (typically
 *                  `state.messagesForQuery`). Not mutated; a new array
 *                  is returned when any truncation occurs.
 * @param toolResultBytesByTurn  Optional I-88 rollout-side index. When
 *                  absent or empty, the helper falls back to measuring
 *                  tool-role message bytes in place.
 * @param config    Budget + truncation thresholds (env > config > default).
 */
export function applyToolResultBudgeting(
  messages: readonly LLMMessage[],
  toolResultBytesByTurn:
    | ReadonlyMap<string, number>
    | Record<string, number>
    | undefined,
  config: {
    readonly maxToolResultBudgetBytes?: number;
    readonly truncateToBytes?: number;
  } = {},
): ToolResultBudgetingResult {
  const envBudget = readEnvBytes("AGENC_TOOL_RESULT_BUDGET_BYTES");
  const envTruncate = readEnvBytes("AGENC_TOOL_RESULT_TRUNCATE_BYTES");
  const maxBudget =
    envBudget ??
    (config.maxToolResultBudgetBytes && config.maxToolResultBudgetBytes > 0
      ? config.maxToolResultBudgetBytes
      : DEFAULT_MAX_TOOL_RESULT_BUDGET_BYTES);
  const truncateTo =
    envTruncate ??
    (config.truncateToBytes && config.truncateToBytes > 0
      ? config.truncateToBytes
      : DEFAULT_TOOL_RESULT_TRUNCATE_BYTES);

  // Seed the running total.
  let indexTotal = 0;
  if (toolResultBytesByTurn) {
    if (toolResultBytesByTurn instanceof Map) {
      for (const n of toolResultBytesByTurn.values()) indexTotal += n;
    } else {
      for (const n of Object.values(toolResultBytesByTurn)) {
        if (typeof n === "number") indexTotal += n;
      }
    }
  }

  // Measure in-place so we always have a live ceiling the budget can
  // walk down. The I-88 index is the authoritative across-turn view; we
  // use whichever is larger to stay conservative.
  const inPlaceSizes: number[] = new Array(messages.length);
  let inPlaceTotal = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m && m.role === "tool") {
      const bytes = messageContentBytes(m.content);
      inPlaceSizes[i] = bytes;
      inPlaceTotal += bytes;
    } else {
      inPlaceSizes[i] = 0;
    }
  }

  let runningTotal = Math.max(indexTotal, inPlaceTotal);
  if (runningTotal <= maxBudget) {
    return { messages: messages as LLMMessage[], bytesFreed: 0, truncatedCount: 0 };
  }

  // Oldest → newest. Truncate any tool-role message whose body exceeds
  // `truncateToBytes`; skip smaller results even when over budget (they
  // already fit the openclaude per-result floor).
  const next: LLMMessage[] = messages.slice();
  let bytesFreed = 0;
  let truncatedCount = 0;
  for (let i = 0; i < next.length; i += 1) {
    if (runningTotal <= maxBudget) break;
    const m = next[i];
    if (!m || m.role !== "tool") continue;
    const bytes = inPlaceSizes[i] ?? messageContentBytes(m.content);
    if (bytes <= truncateTo) continue;
    const replaced = truncateToolMessage(m, bytes, truncateTo);
    const newBytes = messageContentBytes(replaced.content);
    const freed = Math.max(0, bytes - newBytes);
    next[i] = replaced;
    bytesFreed += freed;
    runningTotal -= freed;
    truncatedCount += 1;
  }

  if (truncatedCount === 0) {
    return { messages: messages as LLMMessage[], bytesFreed: 0, truncatedCount: 0 };
  }
  return { messages: next, bytesFreed, truncatedCount };
}

interface AutoCompactModule {
  autoCompactIfNeeded?: (...args: unknown[]) => Promise<{
    wasCompacted: boolean;
    compactionResult?: unknown;
    consecutiveFailures?: number;
  }>;
}

interface MicroCompactModule {
  microcompactMessages?: (...args: unknown[]) => Promise<{
    messages: LLMMessage[];
    compactionInfo?: unknown;
  }>;
}

interface SnipCompactModule {
  snipCompactIfNeeded?: (messages: LLMMessage[]) => {
    messages: LLMMessage[];
    tokensFreed: number;
  };
}

export interface PrepareContextTerminalState {
  readonly terminal: Terminal;
  readonly assistantMessage: AssistantMessage;
}

const PREPARE_CONTEXT_TERMINAL = Symbol("prepare_context_terminal");

type TurnStateWithPrepareContextTerminal = TurnState & {
  [PREPARE_CONTEXT_TERMINAL]?: PrepareContextTerminalState;
};

interface PrepareContextRuntimeOptions {
  readonly querySource?: QuerySource;
  readonly taskBudget?: { readonly total: number };
  readonly reactiveCompact?: {
    readonly isReactiveCompactEnabled?: () => boolean;
  };
  readonly contextCollapse?: {
    readonly isContextCollapseEnabled?: () => boolean;
    readonly isEnabled?: () => boolean;
  };
}

function clearPrepareContextTerminal(state: TurnState): void {
  delete (state as TurnStateWithPrepareContextTerminal)[PREPARE_CONTEXT_TERMINAL];
}

function setPrepareContextTerminal(
  state: TurnState,
  message: string,
): void {
  (state as TurnStateWithPrepareContextTerminal)[PREPARE_CONTEXT_TERMINAL] = {
    terminal: { reason: "blocking_limit" },
    assistantMessage: {
      uuid: crypto.randomUUID(),
      role: "assistant",
      text: message,
      toolCalls: [],
      apiError: "prompt_too_long",
    },
  };
}

export function getPrepareContextTerminal(
  state: TurnState,
): PrepareContextTerminalState | undefined {
  return (state as TurnStateWithPrepareContextTerminal)[PREPARE_CONTEXT_TERMINAL];
}

function resolvePrepareContextRuntimeOptions(
  ctx: TurnContext,
  session: Session,
): Required<Pick<PrepareContextRuntimeOptions, "querySource">> &
  Omit<PrepareContextRuntimeOptions, "querySource"> {
  const fromCtx = ctx as TurnContext & PrepareContextRuntimeOptions;
  const fromSession = session as Session & {
    services?: PrepareContextRuntimeOptions;
  };
  return {
    querySource:
      fromCtx.querySource ??
      fromSession.services?.querySource ??
      "repl_main_thread",
    taskBudget: fromCtx.taskBudget ?? fromSession.services?.taskBudget,
    reactiveCompact:
      fromCtx.reactiveCompact ?? fromSession.services?.reactiveCompact,
    contextCollapse:
      fromCtx.contextCollapse ?? fromSession.services?.contextCollapse,
  };
}

function isContextCollapseEnabledForPrepareContext(
  runtimeOptions: ReturnType<typeof resolvePrepareContextRuntimeOptions>,
): boolean {
  const collapse = runtimeOptions.contextCollapse;
  if (!collapse) return false;
  if (typeof collapse.isContextCollapseEnabled === "function") {
    return collapse.isContextCollapseEnabled();
  }
  if (typeof collapse.isEnabled === "function") {
    return collapse.isEnabled();
  }
  return false;
}

function isReactiveCompactEnabledForPrepareContext(
  runtimeOptions: ReturnType<typeof resolvePrepareContextRuntimeOptions>,
): boolean {
  const reactiveCompact = runtimeOptions.reactiveCompact;
  if (!reactiveCompact) return false;
  if (typeof reactiveCompact.isReactiveCompactEnabled === "function") {
    return reactiveCompact.isReactiveCompactEnabled();
  }
  return false;
}

export async function prepareContext(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  _signal?: AbortSignal,
): Promise<TurnState> {
  clearPrepareContextTerminal(state);
  const runtimeOptions = resolvePrepareContextRuntimeOptions(ctx, session);

  // Stage 1: compact-boundary projection (openclaude query.ts:369).
  let messagesForQuery = getMessagesAfterCompactBoundary(state.messages);

  // Stages 2-7: compaction pipeline. Stages 3/4/6 dynamically import
  // into `runtime/src/llm/compact/**` via `safeCompactImport` so
  // tsup/esbuild traces each stage module into the runtime bundle.
  // A stage that fails to resolve returns `null` and becomes a no-op
  // for that turn; a stage that resolves but throws during load or
  // execution emits `warning:compact_stage_failed` with the stage
  // label.

  // Stage 2 — I-88-driven tool-result budgeting (ports
  // openclaude `query.ts:~369` + `toolResultStorage.ts`).
  // Byte-index source: `session.rolloutStore` (`RolloutStore` owns the
  // I-88 per-turn tally at `rollout-store.ts:76/82`). Falls back to
  // measuring tool-role messages in-place when the rollout store is
  // absent (degraded/no-rollout sessions, subagents without persistence).
  const rolloutStore = (session as unknown as {
    rolloutStore?: {
      getToolResultBytesIndexSnapshot?: () => ReadonlyMap<string, number>;
    } | null;
  }).rolloutStore;
  const toolResultBytesByTurn =
    rolloutStore?.getToolResultBytesIndexSnapshot?.();
  const budget = applyToolResultBudgeting(
    messagesForQuery,
    toolResultBytesByTurn,
    {
      ...(ctx.configSnapshot.toolBudget?.maxToolResultBudgetBytes !== undefined
        ? {
            maxToolResultBudgetBytes:
              ctx.configSnapshot.toolBudget.maxToolResultBudgetBytes,
          }
        : {}),
      ...(ctx.configSnapshot.toolBudget?.truncateToBytes !== undefined
        ? {
            truncateToBytes: ctx.configSnapshot.toolBudget.truncateToBytes,
          }
        : {}),
    },
  );
  if (budget.truncatedCount > 0) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "tool_result_budget_truncated",
          message: `${budget.truncatedCount} tool result(s) truncated, ${budget.bytesFreed}B freed`,
        },
      },
    });
    messagesForQuery = budget.messages;
  }

  // Stage 3: snip compaction.
  let snipTokensFreed = 0;
  const snipMod = await safeCompactImport<SnipCompactModule>(
    "snip_compact",
    () => import("../llm/compact/snip-compact.js"),
    session,
  );
  if (snipMod?.snipCompactIfNeeded) {
    try {
      const result = snipMod.snipCompactIfNeeded(messagesForQuery);
      messagesForQuery = result.messages;
      snipTokensFreed = result.tokensFreed;
      state.snipTokensFreed = snipTokensFreed;
    } catch (error) {
      // Real error emission (was silent in the pre-T4-gap helper).
      // Unified `compact_stage_failed` cause keeps every compaction
      // failure under one greppable event class — see the load-side
      // emission in `safeCompactImport`.
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "compact_stage_failed",
            message: `compact stage snip_compact threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        },
      });
    }
  }

  // Stage 4: microCompact.
  const runtimeQuerySource = runtimeOptions.querySource ?? "repl_main_thread";
  const compactRuntimeContext = createSessionBackedCompactContext(session, {
    querySource: runtimeQuerySource,
    turnContext: ctx,
    cwd: ctx.cwd,
    isNonInteractiveSession: false,
  });
  const microMod = await safeCompactImport<MicroCompactModule>(
    "micro_compact",
    () => import("../llm/compact/micro-compact.js"),
    session,
  );
  if (microMod?.microcompactMessages) {
    try {
      const result = await microMod.microcompactMessages(
        messagesForQuery,
        compactRuntimeContext,
        runtimeQuerySource,
      );
      messagesForQuery = result.messages;
    } catch (error) {
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "compact_stage_failed",
            message: `compact stage micro_compact threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        },
      });
    }
  }

  // Stage 5: context-collapse projection (T7+ wires the real collapse
  // store). Collapses are feature-gated in openclaude; for AgenC the
  // feature flag is unset by default in T5, so the call is a no-op
  // until the T7 context-collapse port lands.

  // Stage 6: autoCompactIfNeeded. Live caller-chain endpoint for
  // I-18 (docs/plan/invariants.md:592-619): when the token threshold
  // fires, `autoCompactIfNeeded` invokes `compactConversation`, which
  // calls `assertCompactionShrank` at the tail. A near-identity
  // summary throws `CompactionShrinkRatioError`; the inner catch in
  // `auto-compact.ts` increments `consecutiveFailures` on the
  // returned tracking state, and we thread that forward onto
  // `state.autoCompactTracking` below so the circuit breaker honours
  // `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3`.
  const autoMod = await safeCompactImport<AutoCompactModule>(
    "auto_compact",
    () => import("../llm/compact/auto-compact.js"),
    session,
  );
  let compactedThisIteration = false;
  if (autoMod?.autoCompactIfNeeded) {
    try {
      const cacheSafeParams = await buildCompactCacheSafeParams(
        compactRuntimeContext,
        messagesForQuery,
      );
      const result = await autoMod.autoCompactIfNeeded(
        messagesForQuery,
        compactRuntimeContext,
        cacheSafeParams,
        runtimeQuerySource,
        state.autoCompactTracking,
        snipTokensFreed,
      );
      if (result.wasCompacted && result.compactionResult) {
        compactedThisIteration = true;
        const compactResult =
          result.compactionResult as Parameters<typeof buildPostCompactMessages>[0];
        session.rolloutStore?.appendRollout(
          {
            type: "compacted",
            payload: buildCompactedRolloutItem(compactResult),
          },
          { durable: true },
        );
        if (runtimeOptions.taskBudget) {
          const preCompactContext =
            finalContextTokensFromLastResponse(messagesForQuery);
          state.taskBudgetRemaining = Math.max(
            0,
            (state.taskBudgetRemaining ?? runtimeOptions.taskBudget.total) -
              preCompactContext,
          );
        }
        // The post-compact messages replace messagesForQuery; the
        // boundary marker plus summary + attachments are authored by
        // compact.ts::buildPostCompactMessages. Persist the matching
        // `compacted` rollout item immediately, then splice the compacted
        // view into this iteration so the stream sees the same boundary.
        messagesForQuery = buildPostCompactMessages(compactResult);
        // Stamp auto-compact tracking so the commit phase emits the
        // boundary marker (runtime/src/phases/commit.ts).
        state.autoCompactTracking = {
          compacted: true,
          turnId: `auto-${Date.now().toString(36)}`,
          turnCounter: 0,
          consecutiveFailures: 0,
        };
      } else if (result.consecutiveFailures !== undefined) {
        state.autoCompactTracking = {
          ...(state.autoCompactTracking ?? {
            compacted: false,
            turnId: "",
            turnCounter: 0,
          }),
          consecutiveFailures: result.consecutiveFailures,
        };
      }
    } catch (error) {
      // Real error emission; unified cause with stages 3 & 4.
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "compact_stage_failed",
            message: `compact stage auto_compact threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        },
      });
    }
  }

  // Stage 7: blocking-limit preempt (openclaude query.ts:596-679).
  // The phase port cannot yield directly, so it stores the typed local
  // terminal + synthetic assistant error message on TurnState for the
  // caller to consume before sampling.
  let collapseOwnsIt = false;
  if (isContextCollapseEnabledForPrepareContext(runtimeOptions)) {
    collapseOwnsIt = isAutoCompactEnabled();
  }
  const reactiveCompactEnabled =
    isReactiveCompactEnabledForPrepareContext(runtimeOptions);
  if (
    !compactedThisIteration &&
    runtimeOptions.querySource !== "compact" &&
    runtimeOptions.querySource !== "session_memory" &&
    !(reactiveCompactEnabled && isAutoCompactEnabled()) &&
    !collapseOwnsIt
  ) {
    const { isAtBlockingLimit } = calculateTokenWarningState(
      tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
      ctx.modelInfo.slug,
    );
    if (isAtBlockingLimit) {
      setPrepareContextTerminal(state, PROMPT_TOO_LONG_ERROR_MESSAGE);
    }
  }

  if (
    state.autoCompactTracking?.consecutiveFailures !== undefined &&
    state.autoCompactTracking.consecutiveFailures >= 3 &&
    isAutoCompactEnabled()
  ) {
    const tokenUsage =
      tokenCountWithEstimation(messagesForQuery) - snipTokensFreed;
    const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
      tokenUsage,
      ctx.modelInfo.slug,
    );
    if (isAboveAutoCompactThreshold) {
      setPrepareContextTerminal(
        state,
        "The conversation has exceeded the context limit and automatic compaction has failed. Press esc twice to go up a few messages and try again, or start a new session with /new.",
      );
    }
  }

  state.messagesForQuery = messagesForQuery;
  return state;
}
