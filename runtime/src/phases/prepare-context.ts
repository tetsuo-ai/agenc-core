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
 * pipeline stages 2-7 call into `runtime/src/llm/compact/**` which is
 * typecheck-excluded until T5b/T6 (see `tsconfig.json` exclude block).
 * The call sites are present below as runtime-dynamic invocations
 * through `safeCompactRequire()`. When the exclude is lifted, the
 * stages light up without this file changing.
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
import type { Session } from "../session/session.js";
import type { Config, TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";

/**
 * Dynamic loader for the compact/ subsystem. Compact/ lives under a
 * typecheck exclude until T5b/T6 lifts it, so we cannot import at the
 * top level without breaking typecheck. `require` at runtime is the
 * AgenC translation of openclaude's feature-guarded `require('./...')`
 * pattern. Result is `null` if the module tree fails to resolve (its
 * external deps aren't in place yet) — callers treat that as "stage
 * disabled", matching openclaude's feature-off behavior.
 */
function safeCompactRequire<T = unknown>(specifier: string): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(specifier);
    return mod as T;
  } catch {
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

export async function prepareContext(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  _signal?: AbortSignal,
): Promise<TurnState> {
  // Stage 1: compact-boundary projection (openclaude query.ts:369).
  let messagesForQuery = getMessagesAfterCompactBoundary(state.messages);

  // Stages 2-7: compaction pipeline. Each stage is a runtime-dynamic
  // call into `runtime/src/llm/compact/**` which is typecheck-
  // excluded until T5b/T6 lifts its external-dep stubs. Until then,
  // safeCompactRequire returns null and the stage is a no-op. The
  // control-flow shape (what order things fire, what happens on
  // success, what happens on failure) is live.

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
  const snipMod = safeCompactRequire<SnipCompactModule>(
    "../llm/compact/snip-compact.js",
  );
  if (snipMod?.snipCompactIfNeeded) {
    try {
      const result = snipMod.snipCompactIfNeeded(messagesForQuery);
      messagesForQuery = result.messages;
      snipTokensFreed = result.tokensFreed;
      state.snipTokensFreed = snipTokensFreed;
    } catch (error) {
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "snip_compact_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      });
    }
  }

  // Stage 4: microCompact.
  const microMod = safeCompactRequire<MicroCompactModule>(
    "../llm/compact/micro-compact.js",
  );
  if (microMod?.microcompactMessages) {
    try {
      const result = await microMod.microcompactMessages(
        messagesForQuery,
        ctx,
        "repl_main_thread",
      );
      messagesForQuery = result.messages;
    } catch (error) {
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "micro_compact_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      });
    }
  }

  // Stage 5: context-collapse projection (T7+ wires the real collapse
  // store). Collapses are feature-gated in openclaude; for AgenC the
  // feature flag is unset by default in T5, so the call is a no-op
  // until the T7 context-collapse port lands.

  // Stage 6: autoCompactIfNeeded.
  const autoMod = safeCompactRequire<AutoCompactModule>(
    "../llm/compact/auto-compact.js",
  );
  if (autoMod?.autoCompactIfNeeded) {
    try {
      const result = await autoMod.autoCompactIfNeeded(
        messagesForQuery,
        ctx,
        state.autoCompactTracking,
        snipTokensFreed,
        "repl_main_thread",
      );
      if (result.wasCompacted && result.compactionResult) {
        // The post-compact messages replace messagesForQuery; the
        // boundary marker plus summary + attachments are authored by
        // compact.ts::buildPostCompactMessages. T6 wires the real
        // rollout-side recording; here we splice into messagesForQuery
        // directly so this iteration's stream sees the compacted view.
        const compactResult = result.compactionResult as {
          summaryMessages: LLMMessage[];
          attachments: LLMMessage[];
          hookResults: LLMMessage[];
        };
        messagesForQuery = [
          ...(compactResult.summaryMessages ?? []),
          ...(compactResult.attachments ?? []),
          ...(compactResult.hookResults ?? []),
        ];
        // Stamp auto-compact tracking so the commit phase emits the
        // boundary marker (runtime/src/phases/commit.ts).
        state.autoCompactTracking = {
          compacted: true,
          turnId: `auto-${Date.now().toString(36)}`,
          turnCounter: 0,
          consecutiveFailures: 0,
        };
      } else if (
        result.consecutiveFailures !== undefined &&
        state.autoCompactTracking
      ) {
        state.autoCompactTracking = {
          ...state.autoCompactTracking,
          consecutiveFailures: result.consecutiveFailures,
        };
      }
    } catch (error) {
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "auto_compact_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      });
    }
  }

  // Stage 7: blocking-limit preempt (openclaude query.ts:596-651).
  // T8 recovery ladder handles the real routing; this is a placeholder
  // slot that will check `calculateTokenWarningState` once its
  // dependencies (token counter, model registry) are wired.

  state.messagesForQuery = messagesForQuery;
  return state;
}
