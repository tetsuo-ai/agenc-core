/**
 * The transport setting for streamed OpenAI Responses calls. Kept apart from
 * the WebSocket session so reading the setting loads no socket code.
 *
 * @module
 */

export type OpenAIResponsesTransport = "http" | "websocket";

/** A configured or environment value; anything else is not a choice. */
export function parseOpenAIResponsesTransport(value: unknown): OpenAIResponsesTransport | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "http" || normalized === "websocket" ? normalized : undefined;
}
