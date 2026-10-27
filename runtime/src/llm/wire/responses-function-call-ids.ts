/**
 * Provider-issued Responses `function_call` item ids.
 *
 * The Responses API gives every function call it emits an item id (`fc_...`)
 * next to the `call_id` that tool results answer. A stateless request sends
 * earlier calls back in its input, and the `id` there must be the one the
 * provider issued, or none. An invented id is not an equivalent: the OpenAI
 * backend accepts it but serves the request on a much slower decode path
 * (GPT-6 Luna on the ChatGPT backend: about 55 tokens/s with invented ids,
 * about 100 with the issued ones).
 *
 * Message history keeps only the call id, so each adapter records the issued
 * id of every call it receives here and the request builder looks it up. A
 * call this adapter has not seen, or no longer remembers, goes back without
 * an id.
 *
 * @module
 */

/** Upper bound on remembered calls; the oldest are forgotten first. */
export const DEFAULT_FUNCTION_CALL_ITEM_ID_CAPACITY = 20_000;

const MAX_ID_LENGTH = 512;

function usableId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    // Ids are opaque tokens; anything with whitespace or control
    // characters is not one the provider issued.
    !/[\s\u0000-\u001f\u007f]/.test(value)
  );
}

/**
 * Bounded map from (provider, call id) to the item id the provider issued
 * for that call. Insertion ordered: remembering a call again refreshes it.
 */
export class ResponsesFunctionCallItemIds {
  private readonly ids = new Map<string, string>();

  constructor(
    private readonly capacity: number = DEFAULT_FUNCTION_CALL_ITEM_ID_CAPACITY,
  ) {}

  private static key(provider: string, callId: string): string {
    return `${provider.trim().toLowerCase()}\u0000${callId}`;
  }

  /**
   * Record a `function_call` output item. Anything else, or an item without
   * a usable call id and item id, is ignored.
   */
  remember(provider: string, item: unknown): void {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return;
    const record = item as Record<string, unknown>;
    if (record.type !== "function_call") return;
    // Some backends omit call_id; the parser then retains item.id as the
    // tool-call token. It still needs observed provenance before replay.
    const callId = record.call_id ?? record.id;
    if (!usableId(callId) || !usableId(record.id)) return;
    const key = ResponsesFunctionCallItemIds.key(provider, callId);
    this.ids.delete(key);
    this.ids.set(key, record.id);
    while (this.ids.size > Math.max(1, this.capacity)) {
      const oldest = this.ids.keys().next();
      if (oldest.done === true) break;
      this.ids.delete(oldest.value);
    }
  }

  /** Record every `function_call` item of a response output array. */
  rememberAll(provider: string, output: unknown): void {
    if (!Array.isArray(output)) return;
    for (const item of output) this.remember(provider, item);
  }

  /** The item id the provider issued for this call, if remembered. */
  get(provider: string, callId: string): string | undefined {
    return this.ids.get(ResponsesFunctionCallItemIds.key(provider, callId));
  }

  /** A lookup bound to one provider, in the shape the request builder takes. */
  lookupFor(provider: string): (callId: string) => string | undefined {
    return (callId) => this.get(provider, callId);
  }

  get size(): number {
    return this.ids.size;
  }

  clear(): void {
    this.ids.clear();
  }
}
