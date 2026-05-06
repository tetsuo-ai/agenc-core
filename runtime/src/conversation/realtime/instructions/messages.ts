import type { LLMMessage } from "../../../llm/types.js";
import {
  REALTIME_CONVERSATION_CLOSE_TAG,
  REALTIME_CONVERSATION_OPEN_TAG,
} from "./markers.js";

export const DEFAULT_REALTIME_START_INSTRUCTIONS = `Realtime conversation started.

You are operating as a backend executor behind an intermediary. The user does not talk to you directly. Any response you produce will be consumed by the intermediary and may be summarized before the user sees it.

When invoked, you receive the latest conversation transcript and any relevant mode or metadata. The intermediary may invoke you even when backend help is not actually needed. Use the transcript to decide whether you should do work. If backend help is unnecessary, avoid verbose responses that add user-visible latency.

When user text is routed from realtime, treat it as a transcript. It may be unpunctuated or contain recognition errors.

- Keep responses concise and action-oriented. Your updates should help the intermediary respond to the user.`;

export const DEFAULT_REALTIME_END_INSTRUCTIONS = `Realtime conversation ended.

Subsequent user input will return to typed text rather than transcript-style text. Do not assume recognition errors or missing punctuation once realtime has ended. Resume normal chat behavior.`;

export function renderRealtimeStartInstructions(): string {
  return renderRealtimeInstructionBody(
    `\n${DEFAULT_REALTIME_START_INSTRUCTIONS.trim()}\n`,
  );
}

export function renderRealtimeEndInstructions(reason: string): string {
  return renderRealtimeInstructionBody(
    `\n${DEFAULT_REALTIME_END_INSTRUCTIONS.trim()}\n\nReason: ${reason}\n`,
  );
}

export function renderRealtimeStartWithInstructions(
  instructions: string,
): string {
  return renderRealtimeInstructionBody(`\n${instructions}\n`);
}

export function realtimeStartInstructionMessage(): LLMMessage {
  return developerInstructionMessage(renderRealtimeStartInstructions());
}

export function realtimeEndInstructionMessage(reason: string): LLMMessage {
  return developerInstructionMessage(renderRealtimeEndInstructions(reason));
}

export function realtimeStartWithInstructionsMessage(
  instructions: string,
): LLMMessage {
  return developerInstructionMessage(
    renderRealtimeStartWithInstructions(instructions),
  );
}

function renderRealtimeInstructionBody(body: string): string {
  return `${REALTIME_CONVERSATION_OPEN_TAG}${body}${REALTIME_CONVERSATION_CLOSE_TAG}`;
}

function developerInstructionMessage(text: string): LLMMessage {
  return {
    role: "developer",
    content: [{ type: "text", text }],
  };
}
