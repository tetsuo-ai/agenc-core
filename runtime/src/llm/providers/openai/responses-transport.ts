/**
 * The transport setting for streamed OpenAI Responses calls. Kept apart from
 * the WebSocket session so reading the setting loads no socket code.
 *
 * @module
 */

export type OpenAIResponsesTransport = "http" | "websocket";

/** A configured or environment value; anything else is not a choice. */
export type OpenAIResponsesToolFormat = "function" | "freeform";

/** A configured or environment tool format; anything else is not a choice. */
export function parseOpenAIResponsesToolFormat(value: unknown): OpenAIResponsesToolFormat | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "function" || normalized === "freeform" ? normalized : undefined;
}

export function parseOpenAIResponsesTransport(value: unknown): OpenAIResponsesTransport | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "http" || normalized === "websocket" ? normalized : undefined;
}
