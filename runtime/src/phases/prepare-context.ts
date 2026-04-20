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
import type { TurnContext } from "../session/turn-context.js";
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

  // Stage 2: tool-result budgeting. openclaude's applyToolResultBudget
  // lives at utils/toolResultStorage.ts (not compact/). T7 ports it
  // into the tools subsystem; this stage lights up when it lands.

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
