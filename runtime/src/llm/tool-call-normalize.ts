/**
 * I-55 — per-provider tool-call normalizer.
 *
 * Providers emit tool_use blocks with slightly different shapes:
 *   - OpenAI / xAI (OpenAI-compatible): `{ id, type:'function', function:{ name, arguments } }`
 *   - Anthropic: `{ id, type:'tool_use', name, input }`
 *   - AgenC canonical `LLMToolCall`: `{ id, name, arguments: string }`
 *
 * The per-provider adapters already project into `LLMToolCall` before
 * the runtime sees them, but residual quirks show up in the wild:
 *   - missing `id` (xAI sometimes omits it on first streaming delta)
 *   - `arguments` as an object rather than a string (anthropic path)
 *   - duplicate ids across parallel calls in the same block
 *   - tool names with provider-specific leading/trailing whitespace
 *
 * This module collapses those quirks into canonical form exactly
 * once, before `validateToolCallsForExecution` runs. Keeping it
 * centralized means future providers only need a switch branch here
 * instead of forking the stream parser.
 *
 * @module
 */

import type { LLMToolCall } from "./types.js";

export interface NormalizeOpts {
  readonly providerName: string;
}

/**
 * Normalize tool calls for a given provider. Returns a fresh array;
 * does not mutate the input.
 */
export function normalizeToolCallsForProvider(
  providerName: string,
  toolCalls: ReadonlyArray<LLMToolCall>,
): LLMToolCall[] {
  if (toolCalls.length === 0) return [];

  const normalized: LLMToolCall[] = [];
  const seenIds = new Set<string>();
  let autoIndex = 0;

  for (const raw of toolCalls) {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (name.length === 0) {
      // Drop obviously broken entries rather than propagate into
      // validation (which would reject them anyway, but only after
      // assigning seq numbers we can't re-use).
      continue;
    }

    // Coerce arguments into a JSON string. Most providers already do
    // this; anthropic-compat paths occasionally hand an object.
    let args = raw.arguments;
    if (args !== undefined && typeof args !== "string") {
      try {
        args = JSON.stringify(args);
      } catch {
        args = "";
      }
    }
    if (typeof args !== "string") args = "";

    // Assign a stable id if the provider omitted one. We use a
    // provider-prefixed auto id so aggregation across providers in
    // a single session never collides.
    let id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : "";
    if (id.length === 0) {
      id = `${providerName}-auto-${autoIndex++}`;
    }
    if (seenIds.has(id)) {
      // Collision within the same assistant block — disambiguate.
      let k = 1;
      while (seenIds.has(`${id}#${k}`)) k += 1;
      id = `${id}#${k}`;
    }
    seenIds.add(id);

    normalized.push({
      id,
      name,
      arguments: args,
    });
  }

  return normalized;
}
