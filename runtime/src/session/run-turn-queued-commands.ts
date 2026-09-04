/**
 * Turn query-source resolution, pending-input ownership and the drain of
 * queued commands after a tool phase. Pure move out of run-turn.ts; the
 * declarations are the originals byte for byte.
 *
 * @module
 */

import type { LLMContentPart } from "../llm/types.js";
import type { QueuedCommand } from "../types/textInputTypes.js";
import type { PhaseEvent } from "../phases/events.js";
import type { IdleInputOwnership, Session } from "./session.js";
import type { SessionSource, TurnContext } from "./turn-context.js";
import {
  getCommandsByMaxPriority,
  isSlashCommand,
  queuedCommandOwnedByConversation,
  queuedCommandWorkspaceView,
  remove as removeFromQueue,
} from "../utils/messageQueueManager.js";
import { wrapCommandText } from "../utils/messages.js";
import { asRecord } from "../utils/record.js";
import type { TurnState } from "./turn-state.js";
import { buildAgenCToolUseContext } from "./agenc-tool-use-context.js";

function isInlineQueuedCommand(command: QueuedCommand): boolean {
  return command.mode === "prompt" || command.mode === "task-notification";
}

function isMainThreadQueueSource(querySource: string): boolean {
  return querySource.startsWith("repl_main_thread") || querySource === "sdk";
}

function isSubagentSessionSource(source: SessionSource): boolean {
  return (
    source === "cli_subagent" ||
    (typeof source === "object" && source.kind === "subagent")
  );
}

function pendingInputOwnershipForTurn(ctx: TurnContext): IdleInputOwnership {
  return ctx.editorInteraction === undefined
    ? { workspaceView: "agent" }
    : {
        workspaceView: "editor",
        editorInteractionId: ctx.editorInteraction.interactionId,
      };
}

function textFromQueuedCommandValue(value: QueuedCommand["value"]): string {
  if (typeof value === "string") return value;
  return value
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function imagePartsFromQueuedCommandValue(
  value: QueuedCommand["value"],
): LLMContentPart[] {
  if (typeof value === "string") return [];
  const parts: LLMContentPart[] = [];
  for (const block of value) {
    if (block.type !== "image") continue;
    const source = block.source;
    if (source.type !== "base64" || source.data.length === 0) continue;
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${source.media_type};base64,${source.data}`,
      },
    });
  }
  return parts;
}

function imagePartsFromQueuedPastes(
  pastedContents: QueuedCommand["pastedContents"],
): LLMContentPart[] {
  if (!pastedContents) return [];
  const parts: LLMContentPart[] = [];
  for (const pasted of Object.values(pastedContents)) {
    if (pasted.type !== "image" || pasted.content.length === 0) continue;
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${pasted.mediaType ?? "image/png"};base64,${pasted.content}`,
      },
    });
  }
  return parts;
}

function queuedCommandContent(
  command: QueuedCommand,
): string | LLMContentPart[] {
  const text = textFromQueuedCommandValue(command.value);
  const origin =
    command.origin ??
    (command.mode === "task-notification"
      ? ({ kind: "task-notification" } as const)
      : undefined);
  const wrapped = `<system-reminder>\n${wrapCommandText(text, origin)}\n</system-reminder>`;
  const imageParts = [
    ...imagePartsFromQueuedCommandValue(command.value),
    ...imagePartsFromQueuedPastes(command.pastedContents),
  ];
  if (imageParts.length === 0) return wrapped;
  return [{ type: "text", text: wrapped }, ...imageParts];
}

function queuedCommandDisplayText(command: QueuedCommand): string {
  if (
    typeof command.preExpansionValue === "string" &&
    command.preExpansionValue.length > 0
  ) {
    return command.preExpansionValue;
  }
  return textFromQueuedCommandValue(command.value);
}

function queuedCommandMatchesTurn(
  command: QueuedCommand,
  querySource: string,
  currentAgentId: string | undefined,
  conversationId: string,
): boolean {
  if (!queuedCommandOwnedByConversation(command, conversationId)) return false;
  if (!isInlineQueuedCommand(command)) return false;
  if (isSlashCommand(command)) return false;
  // Explicit Editor ownership is presentation- and policy-sensitive. Preserve
  // those commands for App's between-turn drain, which applies the matching
  // workspace sync and proposal-review gates before submission.
  if (queuedCommandWorkspaceView(command) === "editor") return false;
  if (isMainThreadQueueSource(querySource)) {
    return command.agentId === undefined;
  }
  return (
    command.mode === "task-notification" &&
    currentAgentId !== undefined &&
    command.agentId === currentAgentId
  );
}

function queuedCommandIsDurableUserPrompt(
  command: QueuedCommand,
  origin: { readonly kind?: unknown } | undefined,
): boolean {
  return (
    command.mode === "prompt" &&
    command.isMeta !== true &&
    (origin === undefined || origin.kind === "human")
  );
}

function drainQueuedCommandsAfterTools(params: {
  readonly state: TurnState;
  readonly session: Session;
  readonly ctx: TurnContext;
  readonly querySource: string;
  readonly sleepRan: boolean;
}): PhaseEvent[] {
  // Commands in the global input queue belong to fresh Agent turns unless
  // explicitly admitted through the Editor-owned mailbox path. Consuming
  // them here would persist and resample an unrelated Agent prompt under the
  // authority of the active immutable Editor interaction.
  if (params.ctx.editorInteraction !== undefined) return [];

  const currentAgentId = isMainThreadQueueSource(params.querySource)
    ? undefined
    : buildAgenCToolUseContext(params.session, params.ctx, {
        querySource: params.querySource,
      }).agentId;
  const commands = getCommandsByMaxPriority(
    params.sleepRan ? "later" : "next",
  ).filter((command) =>
    queuedCommandMatchesTurn(
      command,
      params.querySource,
      currentAgentId,
      params.session.conversationId,
    ),
  );
  if (commands.length === 0) return [];

  const events: PhaseEvent[] = [];
  for (const command of commands) {
    const content = queuedCommandContent(command);
    const origin =
      command.origin ??
      (command.mode === "task-notification"
        ? ({ kind: "task-notification" } as const)
        : undefined);
    const durableUserPrompt = queuedCommandIsDurableUserPrompt(command, origin);
    const uuid =
      typeof command.uuid === "string" ? command.uuid : crypto.randomUUID();
    const displayText = queuedCommandDisplayText(command);
    params.state.toolResults.push({
      uuid,
      role: "user",
      kind: "attachment",
      content,
    });
    params.state.messages.push({
      role: "user",
      content,
      runtimeOnly: {
        mergeBoundary: "user_context",
        ...(!durableUserPrompt
          ? { excludeFromDurableHistory: true as const }
          : // Durable prompts emit a `user_message` event with `id: uuid`
            // below — stamp the same id so file-history rewind can find
            // the sidecar's barrier snapshot for this message.
            { userMessageId: uuid }),
      },
    });
    if (durableUserPrompt) {
      params.session.emit({
        id: uuid,
        msg: {
          type: "user_message",
          payload: {
            message: content,
            displayText,
            queuedCommandUuid: uuid,
          },
        },
      });
    }
    events.push({
      type: "queued_command",
      uuid,
      commandMode:
        command.mode === "task-notification" ? "task-notification" : "prompt",
      content,
      displayText,
      ...(!durableUserPrompt ? { isMeta: true as const } : {}),
      ...(origin?.kind !== undefined
        ? { originKind: String(origin.kind) }
        : {}),
    });
  }
  removeFromQueue(commands);
  return events;
}

function sessionQuerySourceForPostSampling(session: Session): string {
  const raw =
    typeof session.services.querySource === "string" &&
    session.services.querySource.length > 0
      ? session.services.querySource
      : "repl_main_thread";
  const sessionConfiguration = asRecord(
    (session as unknown as { readonly sessionConfiguration?: unknown })
      .sessionConfiguration,
  );
  const sourceKind = asRecord(sessionConfiguration?.sessionSource)?.kind;
  if (raw === "repl_main_thread" && sourceKind === "subagent") {
    return `agent:${session.conversationId}`;
  }
  return raw;
}

function sessionQuerySourceForTurn(
  session: Session,
  override?: string,
): string {
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return sessionQuerySourceForPostSampling(session);
}

// Shared with run-turn.ts and its sibling modules.
export {
  isMainThreadQueueSource,
  isSubagentSessionSource,
  pendingInputOwnershipForTurn,
  drainQueuedCommandsAfterTools,
  sessionQuerySourceForTurn,
};
