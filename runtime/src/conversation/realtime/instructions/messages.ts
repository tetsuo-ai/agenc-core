import type { LLMMessage } from "../../../llm/types.js";
import {
  REALTIME_CONVERSATION_CLOSE_TAG,
  REALTIME_CONVERSATION_OPEN_TAG,
} from "./markers.js";
import {
  DEFAULT_REALTIME_END_INSTRUCTIONS,
  DEFAULT_REALTIME_START_INSTRUCTIONS,
} from "../prompt.js";

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
