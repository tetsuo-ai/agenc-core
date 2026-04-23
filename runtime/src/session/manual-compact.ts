import {
  buildCompactedRolloutItem,
  buildPostCompactMessages,
  type CompactionResult,
} from "../llm/compact/compact.js";
import { feature } from "bun:bundle";
import chalk from "chalk";
import { getUserContext } from "./_deps/system-prompt.js";
import { getShortcutDisplay, getUpgradeMessage } from "./_deps/display.js";
import { notifyCompaction, setLastSummarizedMessageId } from "./_deps/no-op.js";
import type { Message } from "../types/message.js";
import { hasExactErrorMessage, logError } from "./_deps/utils.js";
import {
  createSyntheticUserCaveatMessage,
  createUserMessage,
  formatCommandInputTags,
  getMessagesAfterCompactBoundary,
} from "./_deps/messages.js";
import {
  buildCompactCacheSafeParams,
  createSessionBackedCompactContext,
  type ManualCompactContext,
} from "./compact-runtime-context.js";
import type { Session, SessionState } from "./session.js";
import { suppressCompactWarning } from "../llm/compact/compact-warning-state.js";
import {
  compactConversation,
  ERROR_MESSAGE_INCOMPLETE_RESPONSE,
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES,
} from "../llm/compact/compact.js";
import {
  microcompactMessages,
  resetMicrocompactState,
} from "../llm/compact/micro-compact.js";
import { runPostCompactCleanup } from "../llm/compact/post-compact-cleanup.js";
import { trySessionMemoryCompaction } from "../llm/compact/session-memory-compact.js";

export type SessionManualCompactOutcome =
  | {
      readonly kind: "ran";
      readonly text: string;
      readonly instructions: string;
    }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "error"; readonly cause: string };

export interface ManualCompactResult {
  readonly type: "compact";
  readonly compactionResult: CompactionResult;
  readonly displayText: string;
}

export type { ManualCompactContext } from "./compact-runtime-context.js";

function readSessionMessages(session: Session): Message[] {
  const snapshot = session.state.unsafePeek() as { history?: Message[] };
  return Array.isArray(snapshot.history) ? [...snapshot.history] : [];
}

async function applyCompactedHistory(
  session: Session,
  instructionsRaw: string,
  displayText: string,
  compactionResult: CompactionResult,
): Promise<void> {
  const finalized = finalizeManualCompactHistory(
    instructionsRaw,
    displayText,
    compactionResult,
  );
  const currentState = session.state.unsafePeek() as SessionState;
  await session.state.swap({
    ...currentState,
    history: finalized.messages,
  });
  session.rolloutStore?.appendRollout(
    {
      type: "compacted",
      payload: buildCompactedRolloutItem(finalized.compactionResult),
    },
    { durable: true },
  );
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "context_compacted",
      payload: {
        summary: compactionResult.userDisplayMessage ?? "manual compact",
      },
    },
  });
  session.rolloutStore?.store.reAppendSessionMetadata?.();
}

export function finalizeManualCompactHistory(
  instructionsRaw: string,
  displayText: string,
  compactionResult: CompactionResult,
): {
  readonly compactionResult: CompactionResult;
  readonly messages: Message[];
} {
  const retainedSlashMessages = buildRetainedSlashMessages(
    instructionsRaw,
    displayText,
  );
  const compactionResultWithSlashMessages: CompactionResult = {
    ...compactionResult,
    messagesToKeep: [
      ...(compactionResult.messagesToKeep ?? []),
      ...retainedSlashMessages,
    ],
  };
  // A full manual compact replaces the live transcript wholesale, so any
  // cached microcompact tool-id state must be invalidated at the same owner.
  resetMicrocompactState();
  return {
    compactionResult: compactionResultWithSlashMessages,
    messages: buildPostCompactMessages(compactionResultWithSlashMessages),
  };
}

export async function runManualCompact(
  args: string,
  context: ManualCompactContext,
): Promise<ManualCompactResult> {
  const { abortController } = context;
  let { messages } = context;

  messages = getMessagesAfterCompactBoundary(messages);

  if (messages.length === 0) {
    throw new Error("No messages to compact");
  }

  const customInstructions = args.trim();

  try {
    if (!customInstructions) {
      const sessionMemoryResult = await trySessionMemoryCompaction(
        messages,
        context.agentId,
      );
      if (sessionMemoryResult) {
        getUserContext.cache.clear?.();
        runPostCompactCleanup(
          context.options.querySource,
          context,
        );
        if (feature("PROMPT_CACHE_BREAK_DETECTION")) {
          notifyCompaction(
            context.options.querySource ?? "compact",
            context.agentId,
          );
        }
        // T5: legacy `markPostCompaction()` resolved to a no-op stub proxy
        // from bootstrap/state.ts (Proxy catch-all). The equivalent
        // post-compaction state in T5 (I-2 `previous_response_id` clear +
        // runtime-owner cleanup) is handled synchronously above by
        // runPostCompactCleanup — see invariants.md I-2.
        suppressCompactWarning();

        return {
          type: "compact",
          compactionResult: sessionMemoryResult,
          displayText: buildDisplayText(context),
        };
      }
    }

    const microcompactResult = await microcompactMessages(messages, context);
    const messagesForCompact = microcompactResult.messages;

    // INTENTIONAL: manual `/compact` calls `compactConversation` directly
    // and does NOT route through `autoCompactIfNeeded`. The user has
    // explicitly requested compaction; the auto-compact threshold gate
    // and consecutive-failure circuit breaker (auto-compact.ts:263-290)
    // are both inappropriate for a user-invoked action:
    //   - Threshold gate would silently no-op when tokens are below the
    //     auto-compact limit even though the user asked to compact now.
    //   - Circuit breaker targets retry storms from auto-compact loops;
    //     a user-invoked manual attempt should proceed on its own merits.
    // openclaude's `/compact` command does the same (commands/compact.ts
    // calls compactConversation directly) and this routing maps to
    // feature-matrix.md:196 (T4-owned manual compact). The I-18 shrink
    // assertion and I-2 previous_response_id clear still run because
    // `compactConversation` enforces the former internally and
    // `runPostCompactCleanup` (below) enforces the latter.
    const result = await compactConversation(
      messagesForCompact,
      context,
      await buildCompactCacheSafeParams(context, messagesForCompact),
      false,
      customInstructions,
      false,
    );

    setLastSummarizedMessageId(undefined);
    suppressCompactWarning();

    getUserContext.cache.clear?.();
    runPostCompactCleanup(
      context.options.querySource,
      context,
    );

    return {
      type: "compact",
      compactionResult: result,
      displayText: buildDisplayText(context, result.userDisplayMessage),
    };
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error("Compaction canceled.");
    } else if (hasExactErrorMessage(error, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)) {
      throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES);
    } else if (
      hasExactErrorMessage(error, ERROR_MESSAGE_INCOMPLETE_RESPONSE)
    ) {
      throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE);
    } else {
      logError(error);
      throw new Error(`Error during compaction: ${error}`);
    }
  }
}

export async function runSessionManualCompact(
  session: Session,
  instructionsRaw: string,
): Promise<SessionManualCompactOutcome> {
  const instructions = instructionsRaw.trim();
  const activeTurn = session.activeTurn.unsafePeek();
  if (activeTurn !== null) {
    return {
      kind: "blocked",
      reason:
        "a turn is currently in flight; wait for it to complete before running /compact",
    };
  }

  const context = {
    ...createSessionBackedCompactContext(session, {
      querySource: "compact",
      isNonInteractiveSession: true,
      verbose: false,
    }),
    messages: readSessionMessages(session),
  };

  try {
    const result = await runManualCompact(instructions, context);
    await applyCompactedHistory(
      session,
      instructionsRaw,
      result.displayText ?? "Compaction complete.",
      result.compactionResult,
    );
    return {
      kind: "ran",
      text: result.displayText ?? "Compaction complete.",
      instructions,
    };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return { kind: "error", cause };
  }
}

function buildDisplayText(
  context: { options: { verbose?: boolean } },
  userDisplayMessage?: string,
): string {
  const upgradeMessage = getUpgradeMessage("tip");
  const expandShortcut = getShortcutDisplay(
    "app:toggleTranscript",
    "Global",
    "ctrl+o",
  );
  const dimmed = [
    ...(context.options.verbose
      ? []
      : [`(${expandShortcut} to see full summary)`]),
    ...(userDisplayMessage ? [userDisplayMessage] : []),
    ...(upgradeMessage ? [upgradeMessage] : []),
  ];
  return chalk.dim("Compacted " + dimmed.join("\n"));
}

function buildRetainedSlashMessages(
  instructionsRaw: string,
  displayText: string,
): Message[] {
  const messages: Message[] = [
    createSyntheticUserCaveatMessage(),
    createUserMessage({
      content: formatCommandInputTags("compact", instructionsRaw),
    }),
  ];
  if (displayText.length > 0) {
    messages.push(
      createUserMessage({
        content: `<local-command-stdout>${displayText}</local-command-stdout>`,
        // Keep the retained stdout as the newest compact-tail message so
        // resume/replay choose the post-compact leaf consistently.
        timestamp: new Date(Date.now() + 100).toISOString(),
      }),
    );
  }
  return messages;
}
