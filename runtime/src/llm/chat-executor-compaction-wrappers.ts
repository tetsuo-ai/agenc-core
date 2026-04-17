/**
 * Per-iteration + reactive compaction wrappers extracted from
 * chat-executor-tool-loop.
 *
 * These helpers wrap the tool loop's model-call boundary with the
 * runtime's two compaction strategies:
 *
 * - {@link runPerIterationCompactionBeforeModelCall} runs the layered
 *   compaction chain (snip -> microcompact -> context-collapse ->
 *   autocompact) before every model call, with PreCompact / PostCompact
 *   hook dispatch around the actual mutation.
 * - {@link callModelWithReactiveCompact} wraps a single provider call
 *   so a 413 (LLMContextWindowExceededError) triggers a reactive-compact
 *   drop + retry, up to the reactive-compact layer's internal attempt
 *   cap.
 *
 * Both helpers depend on the same tool-loop callback surface
 * ({@link ToolLoopCallbacks}) so they can emit execution-trace events
 * aligned with the rest of the loop.
 *
 * @module
 */

import type { LLMResponse } from "./types.js";
import type {
  ExecutionContext,
  ChatCallUsageRecord,
} from "./chat-executor-types.js";
import type {
  ToolLoopCallbacks,
  ToolLoopConfig,
} from "./chat-executor-tool-loop.js";
import {
  applyPerIterationCompaction,
  computeAutocompactThreshold,
} from "./compact/index.js";
import { applyReactiveCompact } from "./compact/reactive-compact.js";
import {
  compactHistory,
  tryProjectedContextCollapse,
} from "./chat-executor-history-compaction.js";
import { runPostCompactCleanup } from "./compact/post-compact-cleanup.js";
import { LLMContextWindowExceededError } from "./errors.js";
import { dispatchHooks, defaultHookExecutor } from "./hooks/index.js";
import { sealPendingToolProtocol } from "./chat-executor-tool-protocol-helpers.js";

/**
 * Extract the `[layer]` tag from a compaction boundary message's
 * content. Returns `"unknown"` if no tag is found. The layers write
 * their tag as the first bracketed token in the boundary content
 * (e.g. `[snip] dropped 12 oldest messages after 610s idle`).
 */
function extractCompactionLayerTag(content: string): string {
  const match = /^\[([a-z_-]+)\]/.exec(content);
  return match?.[1] ?? "unknown";
}

export async function runPerIterationCompactionBeforeModelCall(
  ctx: ExecutionContext,
  config: ToolLoopConfig,
  callbacks: ToolLoopCallbacks,
  phase: ChatCallUsageRecord["phase"],
): Promise<void> {
  const result = applyPerIterationCompaction({
    messages: ctx.messages,
    state: ctx.perIterationCompaction,
    nowMs: Date.now(),
    autocompactThresholdTokens: computeAutocompactThreshold(
      config.contextWindowTokens,
      config.maxOutputTokens,
    ),
    lastResponseUsage: ctx.response?.usage,
    collapseHook: (messages) => {
      const projected = tryProjectedContextCollapse({
        history: messages,
        sessionId: ctx.sessionId,
        existingArtifactContext: ctx.compactedArtifactContext,
        autocompactThresholdTokens: computeAutocompactThreshold(
          config.contextWindowTokens,
          config.maxOutputTokens,
        ),
      });
      if (!projected) {
        return {
          action: "noop" as const,
          messages,
        };
      }
      ctx.compacted = true;
      ctx.compactedArtifactContext = projected.artifactContext;
      return {
        action: "collapsed" as const,
        messages: projected.history,
        boundary: projected.boundary,
      };
    },
    ...(config.consolidationHook
      ? { consolidationHook: config.consolidationHook }
      : {}),
  });

  ctx.perIterationCompaction = result.state;

  if (result.action === "noop") return;

  // Phase H: dispatch PreCompact for each layer that fired, with the
  // registry-supplied matcher allowed to veto.
  if (config.hookRegistry) {
    for (const boundary of result.boundaries) {
      const content =
        typeof boundary.content === "string" ? boundary.content : "";
      const layer = extractCompactionLayerTag(content) as
        | "snip"
        | "microcompact"
        | "context-collapse"
        | "autocompact"
        | "reactive-compact";
      await dispatchHooks({
        registry: config.hookRegistry,
        event: "PreCompact",
        matchKey: layer,
        executor: defaultHookExecutor,
        context: {
          event: "PreCompact",
          sessionId: ctx.sessionId,
          layer,
        },
      });
    }
  }

  // Snip and microcompact actually prune messages; autocompact is
  // decision-only and hands the pruned view back unchanged.
  if (result.messages.length !== ctx.messages.length) {
    // The compaction chain returns a readonly slice. We need a mutable
    // array on ctx.messages so the rest of the loop can push to it.
    // Preserve section alignment by trimming messageSections to match.
    const droppedCount = ctx.messages.length - result.messages.length;
    ctx.messages = [...result.messages];
    if (ctx.messageSections.length >= droppedCount) {
      ctx.messageSections.splice(0, droppedCount);
    }
  }

  for (const boundary of result.boundaries) {
    const content =
      typeof boundary.content === "string" ? boundary.content : "";
    callbacks.emitExecutionTrace(ctx, {
      type: "compaction_triggered",
      phase,
      callIndex: ctx.callIndex,
      payload: {
        layer: extractCompactionLayerTag(content),
        boundary: content,
        messagesAfter: ctx.messages.length,
      },
    });
  }

  // Phase H: dispatch PostCompact for each layer that fired, AFTER
  // ctx.messages has been updated so hooks observe the new state.
  if (config.hookRegistry) {
    for (const boundary of result.boundaries) {
      const content =
        typeof boundary.content === "string" ? boundary.content : "";
      const layer = extractCompactionLayerTag(content) as
        | "snip"
        | "microcompact"
        | "context-collapse"
        | "autocompact"
        | "reactive-compact";
      await dispatchHooks({
        registry: config.hookRegistry,
        event: "PostCompact",
        matchKey: layer,
        executor: defaultHookExecutor,
        context: {
          event: "PostCompact",
          sessionId: ctx.sessionId,
          layer,
        },
      });
    }
  }
}

/**
 * Wrap a provider call with reactive compaction.
 *
 * When the provider returns an {@link LLMContextWindowExceededError}
 * (HTTP 413 or a provider-specific prompt-too-long error), invoke
 * {@link applyReactiveCompact} on `ctx.messages` to drop the oldest
 * messages, update the state, and retry the call. Repeat up to the
 * reactive-compact layer's internal limit; it returns `"exhausted"`
 * after that, at which point the original 413 is rethrown.
 *
 * If any tool-turn is open when the 413 fires, the turn is sealed
 * (synthetic error close-out) before the retry so the subsequent call
 * doesn't see a dangling tool-call id.
 */
export async function callModelWithReactiveCompact(
  ctx: ExecutionContext,
  callbacks: ToolLoopCallbacks,
  phase: ChatCallUsageRecord["phase"],
  buildInput: () => Parameters<ToolLoopCallbacks["callModelForPhase"]>[1],
  compactionDeps?: import("./chat-executor-history-compaction.js").HistoryCompactionDependencies,
): Promise<LLMResponse | undefined> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await callbacks.callModelForPhase(ctx, buildInput());
    } catch (err) {
      if (!(err instanceof LLMContextWindowExceededError)) {
        throw err;
      }
      sealPendingToolProtocol(ctx, callbacks, "reactive_compact_retry");
      const reactiveState =
        ctx.perIterationCompaction.reactiveCompact ?? {
          attemptIndex: 0,
          lastTriggerMs: null,
        };

      // On first 413, try summarization before truncation. The
      // reference runtime's proactive autocompact prevents most 413s,
      // but when one slips through, summarization preserves more
      // context than blind oldest-first truncation.
      if (reactiveState.attemptIndex === 0 && compactionDeps) {
        try {
          const compacted = await compactHistory(
            ctx.messages,
            ctx.sessionId,
            compactionDeps,
            {
              existingArtifactContext: ctx.compactedArtifactContext,
            },
          );
          ctx.messages = [...compacted.history];
          ctx.compactedArtifactContext = compacted.artifactContext;
          ctx.compacted = true;
          runPostCompactCleanup(ctx.sessionId);
          ctx.perIterationCompaction = {
            ...ctx.perIterationCompaction,
            reactiveCompact: {
              attemptIndex: 1,
              lastTriggerMs: Date.now(),
            },
          };
          callbacks.emitExecutionTrace(ctx, {
            type: "compaction_triggered",
            phase,
            callIndex: ctx.callIndex,
            payload: {
              layer: "reactive-compact",
              boundary:
                "[reactive-compact] summarized context on 413 (attempt 1)",
              messagesAfter: ctx.messages.length,
              attempt: 1,
            },
          });
          continue;
        } catch {
          // Summarization failed (may have 413'd itself) — fall
          // through to the truncation chain.
        }
      }

      const result = applyReactiveCompact({
        messages: ctx.messages,
        state: reactiveState,
        nowMs: Date.now(),
      });
      if (result.action === "exhausted" || result.action === "noop") {
        throw err;
      }
      ctx.messages = [...result.messages];
      ctx.perIterationCompaction = {
        ...ctx.perIterationCompaction,
        reactiveCompact: result.state,
      };
      if (result.boundary && typeof result.boundary.content === "string") {
        callbacks.emitExecutionTrace(ctx, {
          type: "compaction_triggered",
          phase,
          callIndex: ctx.callIndex,
          payload: {
            layer: "reactive-compact",
            boundary: result.boundary.content,
            messagesAfter: ctx.messages.length,
            attempt: result.state.attemptIndex,
          },
        });
      }
    }
  }
}
