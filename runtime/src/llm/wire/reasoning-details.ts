/**
 * Structured `reasoning_details` replay for Chat Completions gateways
 * (OpenRouter, Venice).
 *
 * A reply carries an array of reasoning items (`reasoning.text`,
 * `reasoning.summary`, `reasoning.encrypted`). For a tool continuation the
 * gateway wants the array back on the assistant message exactly as it was
 * returned; GPT models keep their reasoning only in the encrypted items, so the
 * summary text alone does not restore it.
 * https://openrouter.ai/docs/use-cases/reasoning-tokens
 *
 * The array is stored as the message's opaque `providerReasoningContent`
 * (bound to the provider and model that produced it, like OpenAI's encrypted
 * Responses items) in a tagged JSON envelope, so it is never mistaken for
 * reasoning text.
 *
 * @module
 */

const ENVELOPE_KEY = "reasoning_details";
const CONCATENATED_FIELDS = ["text", "summary", "data", "signature"] as const;

type ReasoningDetail = Record<string, unknown>;

function isDetail(value: unknown): value is ReasoningDetail {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as ReasoningDetail).type === "string";
}

/**
 * Accumulates streamed `delta.reasoning_details` fragments. Fragments with
 * the same `index` belong to one item: its text, summary, encrypted data and
 * signature arrive in pieces, everything else once.
 */
export class ReasoningDetailsAccumulator {
  readonly #items = new Map<number, ReasoningDetail>();
  #next = 0;

  push(fragments: unknown): void {
    if (!Array.isArray(fragments)) return;
    for (const fragment of fragments) {
      if (!isDetail(fragment)) continue;
      const index = typeof fragment.index === "number" && Number.isSafeInteger(fragment.index)
        ? fragment.index
        : this.#next;
      this.#next = Math.max(this.#next, index + 1);
      const existing = this.#items.get(index);
      if (existing === undefined || existing.type !== fragment.type) {
        this.#items.set(index, { ...fragment });
        continue;
      }
      for (const [key, value] of Object.entries(fragment)) {
        if ((CONCATENATED_FIELDS as readonly string[]).includes(key) &&
            typeof value === "string" && typeof existing[key] === "string") {
          existing[key] = (existing[key] as string) + value;
        } else if (existing[key] === undefined || existing[key] === null) {
          existing[key] = value;
        }
      }
    }
  }

  get size(): number {
    return this.#items.size;
  }

  items(): ReasoningDetail[] {
    return [...this.#items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
  }
}

/** The opaque replay state for a reply's reasoning items, or undefined when there are none. */
export function encodeReasoningDetailsReplay(details: unknown): string | undefined {
  if (!Array.isArray(details)) return undefined;
  const items = details.filter(isDetail);
  return items.length > 0 ? JSON.stringify({ [ENVELOPE_KEY]: items }) : undefined;
}

/** The reasoning items stored by `encodeReasoningDetailsReplay`, or undefined for any other content. */
export function decodeReasoningDetailsReplay(content: string | undefined): ReasoningDetail[] | undefined {
  if (content === undefined || !content.startsWith(`{"${ENVELOPE_KEY}":`)) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    const items = parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)[ENVELOPE_KEY]
      : undefined;
    return Array.isArray(items) && items.length > 0 && items.every(isDetail) ? items : undefined;
  } catch {
    return undefined;
  }
}
