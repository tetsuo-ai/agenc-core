import {
  buildCompactedRolloutItem,
  buildPostCompactMessages,
  type CompactionResult,
} from "../llm/compact/compact.js";
import { feature } from "bun:bundle";
import chalk from "chalk";
import { markPostCompaction } from "src/bootstrap/state.js";
import { getUserContext } from "../context.js";
import { getShortcutDisplay } from "../keybindings/shortcutFormat.js";
import { notifyCompaction } from "../services/api/promptCacheBreakDetection.js";
import { setLastSummarizedMessageId } from "../services/SessionMemory/sessionMemoryUtils.js";
import type { Message } from "../types/message.js";
import { hasExactErrorMessage } from "../utils/errors.js";
import { logError } from "../utils/log.js";
import {
  createSyntheticUserCaveatMessage,
  createUserMessage,
  formatCommandInputTags,
  getMessagesAfterCompactBoundary,
} from "../utils/messages.js";
import { getUpgradeMessage } from "../utils/model/contextWindowUpgradeCheck.js";
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
import { microcompactMessages } from "../llm/compact/micro-compact.js";
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
  const compactedMessages = buildPostCompactMessages(
    compactionResultWithSlashMessages,
  );
  const currentState = session.state.unsafePeek() as SessionState;
  await session.state.swap({
    ...currentState,
    history: compactedMessages,
  });
  session.rolloutStore?.appendRollout(
    {
      type: "compacted",
      payload: buildCompactedRolloutItem(compactionResultWithSlashMessages),
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
        runPostCompactCleanup();
        if (feature("PROMPT_CACHE_BREAK_DETECTION")) {
          notifyCompaction(
            context.options.querySource ?? "compact",
            context.agentId,
          );
        }
        markPostCompaction();
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
    runPostCompactCleanup();

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
