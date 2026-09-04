/**
 * Message and user-content primitives for run-turn, plus the seed and
 * instruction assembly helpers the kernel uses to open a turn. Pure move
 * out of run-turn.ts; the declarations are the originals byte for byte.
 *
 * @module
 */

import type { LLMContentPart, LLMMessage } from "../llm/types.js";
import { cloneLlmContent as cloneContent } from "../llm/content-conversion.js";
import { safeStringify } from "../tools/types.js";
import {
  realtimeEndInstructionMessage,
  realtimeStartInstructionMessage,
  realtimeStartWithInstructionsMessage,
} from "../conversation/realtime/instructions/messages.js";
import {
  getModelInstructions,
  modelSupportsPersonality,
  normalizePersonality,
  personalityMessageForModel,
  personalitySpecInstructionMessage,
  type Personality,
} from "../context/personality-spec-instructions.js";
import type { Session } from "./session.js";
import type { TurnContext, TurnContextItem } from "./turn-context.js";
import type { RunTurnOptions } from "./run-turn.js";

function cloneLLMMessage(message: LLMMessage): LLMMessage {
  return {
    ...message,
    content: cloneContent(message.content),
  };
}

function excludeFromDurableHistory(message: LLMMessage): boolean {
  return message.runtimeOnly?.excludeFromDurableHistory === true;
}

function buildSeedMessages(
  opts: RunTurnOptions,
  userContent: string | LLMContentPart[],
): { system?: LLMMessage; prior: LLMMessage[]; user: LLMMessage } {
  const system: LLMMessage | undefined = opts.systemPrompt
    ? { role: "system", content: opts.systemPrompt }
    : undefined;
  const prior: LLMMessage[] = [...(opts.history ?? [])];
  const user: LLMMessage = {
    role: "user",
    content: userContent,
    ...(opts.seedUserMessageRuntimeOnly !== undefined
      ? { runtimeOnly: { ...opts.seedUserMessageRuntimeOnly } }
      : {}),
  };
  return { system, prior, user };
}

interface ContextualUpdatePreviousTurnSettings {
  readonly realtimeActive?: boolean;
  readonly personality?: Personality;
}

function readRealtimeUpdateBaseline(session: Session): {
  readonly previousContextItem?: TurnContextItem;
  readonly previousTurnSettings?: ContextualUpdatePreviousTurnSettings;
} {
  const peek = (
    session.state as unknown as {
      unsafePeek?: () => {
        readonly referenceContextItem?: TurnContextItem;
        readonly previousTurnSettings?: ContextualUpdatePreviousTurnSettings;
      };
    }
  ).unsafePeek?.();
  return {
    ...(peek?.referenceContextItem !== undefined
      ? { previousContextItem: peek.referenceContextItem }
      : {}),
    ...(peek?.previousTurnSettings !== undefined
      ? { previousTurnSettings: peek.previousTurnSettings }
      : {}),
  };
}

function buildRealtimeInstructionUpdateMessage(
  previousContextItem: TurnContextItem | undefined,
  previousTurnSettings: ContextualUpdatePreviousTurnSettings | undefined,
  ctx: TurnContext,
): LLMMessage | undefined {
  const previousRealtimeActive =
    previousContextItem?.realtimeActive ?? previousTurnSettings?.realtimeActive;
  if (previousRealtimeActive === true && ctx.realtimeActive === false) {
    return realtimeEndInstructionMessage("inactive");
  }
  if (
    (previousRealtimeActive === false ||
      previousRealtimeActive === undefined) &&
    ctx.realtimeActive === true
  ) {
    const instructions = realtimeStartInstructionsOverride(ctx);
    return instructions !== undefined
      ? realtimeStartWithInstructionsMessage(instructions)
      : realtimeStartInstructionMessage();
  }
  return undefined;
}

function buildPersonalitySpecUpdateMessage(
  previousContextItem: TurnContextItem | undefined,
  previousTurnSettings: ContextualUpdatePreviousTurnSettings | undefined,
  ctx: TurnContext,
): LLMMessage | undefined {
  if (ctx.features?.enabled?.("personality") === false) return undefined;
  const hasPrevious =
    previousContextItem !== undefined || previousTurnSettings !== undefined;
  if (!hasPrevious) return undefined;
  const personality = resolveTurnPersonality(ctx);
  if (personality === undefined || personality === "none") return undefined;
  if (!modelSupportsPersonality(ctx.modelInfo.modelMessages)) return undefined;
  const previousPersonality = normalizePersonality(
    previousContextItem?.personality ?? previousTurnSettings?.personality,
  );
  if (previousPersonality === personality) return undefined;
  const message = personalityMessageForModel(ctx.modelInfo, personality);
  return message !== undefined && message.length > 0
    ? personalitySpecInstructionMessage(message)
    : undefined;
}

function resolveTurnPersonality(ctx: TurnContext): Personality | undefined {
  return normalizePersonality(ctx.personality ?? ctx.config.personality);
}

function resolveModelInstructionsForTurn(
  ctx: TurnContext,
  baseInstructions: string,
): string {
  return getModelInstructions({
    modelInfo: ctx.modelInfo,
    baseInstructions,
    personality: resolveTurnPersonality(ctx),
  });
}

function realtimeStartInstructionsOverride(
  ctx: TurnContext,
): string | undefined {
  const value = (
    ctx.config as {
      readonly experimental_realtime_start_instructions?: unknown;
    }
  ).experimental_realtime_start_instructions;
  return typeof value === "string" ? value : undefined;
}

function messageText(message: LLMMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return safeStringify(message.content);
}

function userContentHasInput(content: string | LLMContentPart[]): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  return content.some((part) => {
    if (part.type === "text") return part.text.trim().length > 0;
    if (part.type === "document") return part.source.data.trim().length > 0;
    return part.image_url.url.trim().length > 0;
  });
}

function userContentDisplayText(content: string | LLMContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "document") return "[document]";
      return "[image]";
    })
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function appendTextPart(parts: LLMContentPart[], text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    parts[parts.length - 1] = {
      type: "text",
      text: `${last.text}\n\n${trimmed}`,
    };
    return;
  }
  parts.push({ type: "text", text: trimmed });
}

function mergePendingInputIntoUserContent(
  userMessage: string | readonly LLMContentPart[],
  pending: readonly LLMMessage[],
): string | LLMContentPart[] {
  if (pending.length === 0) {
    return typeof userMessage === "string" ? userMessage : [...userMessage];
  }
  const hasMultimodalContent =
    pending.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => part.type !== "text"),
    ) || Array.isArray(userMessage);
  if (!hasMultimodalContent) {
    const parts = [
      typeof userMessage === "string" && userMessage.trim().length > 0
        ? userMessage
        : "",
      ...pending.map(messageText).filter((part) => part.trim().length > 0),
    ].filter((part) => part.length > 0);
    return parts.join("\n\n");
  }

  const contentParts: LLMContentPart[] = [];
  if (typeof userMessage === "string") {
    appendTextPart(contentParts, userMessage);
  } else {
    contentParts.push(...userMessage);
  }
  for (const message of pending) {
    if (typeof message.content === "string") {
      appendTextPart(contentParts, message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") {
        appendTextPart(contentParts, part.text);
      } else if (part.type === "document") {
        if (part.source.data.trim().length > 0) contentParts.push(part);
      } else if (part.image_url.url.trim().length > 0) {
        contentParts.push(part);
      }
    }
  }
  return contentParts;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

// Shared with run-turn.ts and its sibling modules.
export {
  cloneLLMMessage,
  excludeFromDurableHistory,
  buildSeedMessages,
  readRealtimeUpdateBaseline,
  buildRealtimeInstructionUpdateMessage,
  buildPersonalitySpecUpdateMessage,
  resolveTurnPersonality,
  resolveModelInstructionsForTurn,
  messageText,
  userContentHasInput,
  userContentDisplayText,
  mergePendingInputIntoUserContent,
  finitePositive,
};
