import { randomUUID } from "node:crypto";

export function makeAssistantTextMessage(
  content: string,
  uuid: string = randomUUID(),
  messageTimestamp: string = new Date().toISOString(),
): any {
  return {
    type: "assistant",
    uuid,
    timestamp: messageTimestamp,
    message: {
      id: randomUUID(),
      container: null,
      model: "agenc",
      role: "assistant",
      stop_reason: "stop_sequence",
      stop_sequence: "",
      type: "message",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [{ type: "text", text: content.length > 0 ? content : "(no content)" }],
      context_management: null,
    },
    requestId: undefined,
  };
}

export function makeToolUseMessage(
  toolUseID: string,
  name: string,
  input: unknown,
  uuid: string = randomUUID(),
): any {
  return {
    ...makeAssistantTextMessage(""),
    uuid,
    message: {
      ...makeAssistantTextMessage("").message,
      content: [{ type: "tool_use", id: toolUseID, name, input }],
    },
  };
}
