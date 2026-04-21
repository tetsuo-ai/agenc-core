import {
  buildCompactedRolloutItem,
  buildPostCompactMessages,
  type CompactionResult,
} from "../llm/compact/compact.js";
import { createSessionBackedCompactContext } from "../llm/compact/runtime-context.js";
import { runManualCompact } from "../llm/compact/manual-compact.js";
import type { Message } from "../types/message.js";
import type { Session, SessionState } from "./session.js";

export type SessionManualCompactOutcome =
  | {
      readonly kind: "ran";
      readonly text: string;
      readonly instructions: string;
    }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "error"; readonly cause: string };

function readSessionMessages(session: Session): Message[] {
  const snapshot = session.state.unsafePeek() as { history?: Message[] };
  return Array.isArray(snapshot.history) ? [...snapshot.history] : [];
}

async function applyCompactedHistory(
  session: Session,
  compactionResult: CompactionResult,
): Promise<void> {
  const compactedMessages = buildPostCompactMessages(compactionResult);
  const currentState = session.state.unsafePeek() as SessionState;
  await session.state.swap({
    ...currentState,
    history: compactedMessages,
  });
  session.rolloutStore?.appendRollout(
    {
      type: "compacted",
      payload: buildCompactedRolloutItem(compactionResult),
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
    await applyCompactedHistory(session, result.compactionResult);
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
