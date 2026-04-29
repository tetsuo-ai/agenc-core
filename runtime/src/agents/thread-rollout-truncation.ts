import type { ResponseItem, RolloutItem } from "../session/rollout-item.js";

export type ForkSnapshot =
  | { readonly kind: "truncate_before_nth_user_message"; readonly n: number }
  | { readonly kind: "interrupted" };

export interface SnapshotTurnState {
  readonly endsMidTurn: boolean;
  readonly activeTurnId?: string;
  readonly activeTurnStartIndex?: number;
}

export function initialHistoryHasPriorUserTurns(
  items: ReadonlyArray<RolloutItem>,
): boolean {
  return items.some(rolloutItemIsUserTurnBoundary);
}

export function userMessagePositionsInRollout(
  items: ReadonlyArray<RolloutItem>,
): number[] {
  const userPositions: number[] = [];
  items.forEach((item, idx) => {
    if (rolloutItemIsUserTurnBoundary(item)) {
      userPositions.push(idx);
      return;
    }
    const rollbackTurns = threadRollbackCount(item);
    if (rollbackTurns !== undefined) {
      userPositions.splice(Math.max(0, userPositions.length - rollbackTurns));
    }
  });
  return userPositions;
}

export function forkTurnPositionsInRollout(
  items: ReadonlyArray<RolloutItem>,
): number[] {
  const rollbackTurnPositions: number[] = [];
  const forkTurnPositions: number[] = [];
  items.forEach((item, idx) => {
    if (item.type === "response_item") {
      if (isUserTurnBoundary(item.payload)) {
        rollbackTurnPositions.push(idx);
      }
      if (
        isRealUserMessageBoundary(item.payload) ||
        isTriggerTurnBoundary(item.payload)
      ) {
        forkTurnPositions.push(idx);
      }
      return;
    }
    const rollbackTurns = threadRollbackCount(item);
    if (rollbackTurns === undefined || rollbackTurns === 0) return;
    const rollbackStart =
      rollbackTurnPositions[
        Math.max(0, rollbackTurnPositions.length - rollbackTurns)
      ] ?? rollbackTurnPositions[0];
    if (rollbackStart === undefined) return;
    rollbackTurnPositions.splice(
      Math.max(0, rollbackTurnPositions.length - rollbackTurns),
    );
    for (let i = forkTurnPositions.length - 1; i >= 0; i -= 1) {
      if (forkTurnPositions[i]! >= rollbackStart) {
        forkTurnPositions.splice(i, 1);
      }
    }
  });
  return forkTurnPositions;
}

export function truncateRolloutBeforeNthUserMessageFromStart(
  items: ReadonlyArray<RolloutItem>,
  nFromStart: number,
): RolloutItem[] {
  if (!Number.isFinite(nFromStart) || nFromStart === Number.MAX_SAFE_INTEGER) {
    return [...items];
  }
  const userPositions = userMessagePositionsInRollout(items);
  if (userPositions.length <= nFromStart) return [...items];
  return items.slice(0, userPositions[nFromStart]);
}

export function truncateRolloutToLastNForkTurns(
  items: ReadonlyArray<RolloutItem>,
  nFromEnd: number,
): RolloutItem[] {
  if (nFromEnd <= 0) return [];
  const positions = forkTurnPositionsInRollout(items);
  if (positions.length <= nFromEnd) return [...items];
  return items.slice(positions[positions.length - nFromEnd]);
}

export function keepForkedRolloutItem(item: RolloutItem): boolean {
  if (item.type === "response_item") {
    const response = item.payload;
    const role = response.role as string;
    if (role === "system" || role === "developer") {
      return true;
    }
    if (role === "user") return true;
    if (role === "assistant") {
      return (
        response.phase === undefined ||
        response.phase === "final_answer" ||
        response.phase === "FinalAnswer"
      );
    }
    return false;
  }
  return (
    item.type === "compacted" ||
    item.type === "event_msg" ||
    item.type === "session_meta"
  );
}

export function filterForkedRolloutItems(
  items: ReadonlyArray<RolloutItem>,
): RolloutItem[] {
  return items.filter(keepForkedRolloutItem).map(cloneRolloutItem);
}

export function snapshotTurnState(
  items: ReadonlyArray<RolloutItem>,
): SnapshotTurnState {
  let activeTurnId: string | undefined;
  let activeTurnStartIndex: number | undefined;
  let activeTurnClosed = false;

  items.forEach((item, idx) => {
    if (item.type !== "event_msg") return;
    const msg = item.payload.msg;
    if (msg.type === "turn_started") {
      activeTurnId = msg.payload.turnId;
      activeTurnStartIndex = idx;
      activeTurnClosed = false;
      return;
    }
    if (
      (msg.type === "turn_complete" || msg.type === "turn_aborted") &&
      (activeTurnId === undefined || msg.payload.turnId === activeTurnId)
    ) {
      activeTurnClosed = true;
    }
  });

  if (activeTurnId !== undefined && !activeTurnClosed) {
    return {
      endsMidTurn: true,
      activeTurnId,
      ...(activeTurnStartIndex !== undefined ? { activeTurnStartIndex } : {}),
    };
  }

  const lastUserPosition = userMessagePositionsInRollout(items).at(-1);
  if (lastUserPosition === undefined) {
    return { endsMidTurn: false };
  }
  const hasTerminalBoundary = items.slice(lastUserPosition + 1).some((item) => {
    if (item.type !== "event_msg") return false;
    const type = item.payload.msg.type;
    return type === "turn_complete" || type === "turn_aborted";
  });
  return { endsMidTurn: !hasTerminalBoundary };
}

export function truncateBeforeNthUserMessage(
  items: ReadonlyArray<RolloutItem>,
  n: number,
  state: SnapshotTurnState = snapshotTurnState(items),
): RolloutItem[] {
  const positions = userMessagePositionsInRollout(items);
  if (state.endsMidTurn && n >= positions.length) {
    const cutIdx = state.activeTurnStartIndex ?? positions.at(-1);
    return cutIdx === undefined ? [...items] : items.slice(0, cutIdx);
  }
  return truncateRolloutBeforeNthUserMessageFromStart(items, n);
}

export function forkSnapshotRollout(
  items: ReadonlyArray<RolloutItem>,
  snapshot: ForkSnapshot,
): RolloutItem[] {
  const state = snapshotTurnState(items);
  if (snapshot.kind === "truncate_before_nth_user_message") {
    return filterForkedRolloutItems(
      truncateBeforeNthUserMessage(items, snapshot.n, state),
    );
  }
  const filtered = filterForkedRolloutItems(items);
  return state.endsMidTurn
    ? appendInterruptedBoundary(filtered, state.activeTurnId)
    : filtered;
}

export function appendInterruptedBoundary(
  items: ReadonlyArray<RolloutItem>,
  turnId?: string,
): RolloutItem[] {
  return [
    ...items.map(cloneRolloutItem),
    {
      type: "response_item",
      payload: {
        role: "user",
        content:
          "<turn_aborted>\nThe previous turn was interrupted.\n</turn_aborted>",
      },
    },
    {
      type: "event_msg",
      payload: {
        id: "thread-manager-interrupted-fork",
        msg: {
          type: "turn_aborted",
          payload: {
            ...(turnId !== undefined ? { turnId } : {}),
            reason: "interrupted",
          },
        },
      },
    },
  ];
}

function rolloutItemIsUserTurnBoundary(item: RolloutItem): boolean {
  return item.type === "response_item" && isUserTurnBoundary(item.payload);
}

function isUserTurnBoundary(item: ResponseItem): boolean {
  return isRealUserMessageBoundary(item) || isTriggerTurnBoundary(item);
}

function isRealUserMessageBoundary(item: ResponseItem): boolean {
  return item.role === "user" && !isContextualUserContent(item.content);
}

function isTriggerTurnBoundary(item: ResponseItem): boolean {
  if (item.role !== "assistant") return false;
  const text = contentText(item.content);
  if (text === undefined) return false;
  try {
    const parsed = JSON.parse(text) as { triggerTurn?: unknown; trigger_turn?: unknown };
    return parsed.triggerTurn === true || parsed.trigger_turn === true;
  } catch {
    return false;
  }
}

function threadRollbackCount(item: RolloutItem): number | undefined {
  if (item.type !== "event_msg") return undefined;
  if (item.payload.msg.type !== "thread_rolled_back") return undefined;
  return Math.max(0, item.payload.msg.payload.numTurns);
}

function isContextualUserContent(content: ResponseItem["content"]): boolean {
  const text = contentText(content);
  if (text === undefined) return false;
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("<turn_aborted>") && trimmed.endsWith("</turn_aborted>")) ||
    (trimmed.startsWith("<subagent_notification>") &&
      trimmed.endsWith("</subagent_notification>")) ||
    (trimmed.startsWith("<environment_context>") &&
      trimmed.endsWith("</environment_context>")) ||
    (trimmed.startsWith("# AGENC.md instructions for ") &&
      trimmed.endsWith("</INSTRUCTIONS>"))
  );
}

function contentText(content: ResponseItem["content"]): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const [first] = content;
  return typeof first?.text === "string" ? first.text : undefined;
}

function cloneRolloutItem(item: RolloutItem): RolloutItem {
  return JSON.parse(JSON.stringify(item)) as RolloutItem;
}
