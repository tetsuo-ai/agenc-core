/**
 * An explicit cache for the fixed head of a Gemini request: the system
 * instruction and the function declarations.
 *
 * Why. Google's implicit cache rarely applies to a small request on
 * gemini-3.1-pro-preview: 2 of 102 recorded Light calls had a cached token
 * (requests of 1,500 to 6,000 tokens), against 60 of 72 calls of a harness
 * whose requests start at 10,700 tokens (2026-11-15). The head is about
 * 1,440 tokens and is sent on every call, so on that model it was billed at
 * the full input price every time. An explicit cache has a guaranteed
 * discount ("cost saving guarantee", ai.google.dev/gemini-api/docs/caching),
 * and the API accepted one of 1,439 tokens on gemini-3.1-pro-preview and
 * gemini-3.8-flash.
 *
 * Rules of the API this file follows:
 * - A request that names a cache must not carry `systemInstruction`,
 *   `tools` or `toolConfig` (HTTP 400 otherwise): they live in the cache.
 * - "Implicit caching doesn't apply when a request uses an explicit cache",
 *   so the provider uses the cache only while the request is small (see
 *   GEMINI_PREFIX_CACHE_MAX_REQUEST_BYTES in index.ts).
 * - Gemini 4 models reject explicit caching; Vertex has other rules.
 *
 * Safety. The model loop sends each request once under a budget lease and
 * the provider may not retry beneath it, so a request never names a cache
 * that could have expired: a cache is used only for USABLE_MS of its TTL_MS
 * life, and a new one is made after that. Creation runs beside the model
 * calls and never delays or fails one. A head is cached at its second
 * sighting, so a one-off request (a title, a summary) creates nothing.
 * When the API refuses a request that named a cache, that head is never
 * cached again in this process, and after a second refusal no head is: a
 * refusal that repeats would otherwise cost a turn every few minutes.
 *
 * Cost outside the token accounting: Google bills the creation as input
 * (about 1,440 tokens every USABLE_MS while a session runs) and the storage.
 */
import { createHash } from "node:crypto";

/** Life of a cache at Google. Storage is billed for this time. */
export const GEMINI_PREFIX_CACHE_TTL_MS = 600_000;
/** How long a cache is named in requests; the rest of its life is margin. */
export const GEMINI_PREFIX_CACHE_USABLE_MS = 420_000;
/** After a failed creation the same head is not tried again for this long. */
export const GEMINI_PREFIX_CACHE_RETRY_MS = 600_000;
const MAX_ENTRIES = 32;

export type GeminiPrefixCacheCreate = (body: Record<string, unknown>) => Promise<string>;

interface Entry {
  sightings: number;
  name?: string;
  usableUntil: number;
  creating: boolean;
  retryAfter: number;
  refused: boolean;
}

/** Refusals of cached requests after which no head is cached any more. */
const MAX_REFUSALS = 2;

export class GeminiPrefixCache {
  private readonly entries = new Map<string, Entry>();
  private refusals = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The cache to name in a request with this head, or undefined when the
   * request must carry the head itself. Starts a creation when one is due.
   */
  lookup(
    model: string,
    systemInstruction: unknown,
    tools: unknown,
    create: GeminiPrefixCacheCreate,
  ): string | undefined {
    if (this.refusals >= MAX_REFUSALS) return undefined;
    const key = createHash("sha256")
      .update(JSON.stringify([model, systemInstruction, tools]))
      .digest("hex");
    let entry = this.entries.get(key);
    if (entry === undefined) {
      if (this.entries.size >= MAX_ENTRIES) {
        this.entries.delete(this.entries.keys().next().value as string);
      }
      entry = { sightings: 0, usableUntil: 0, creating: false, retryAfter: 0, refused: false };
      this.entries.set(key, entry);
    }
    entry.sightings += 1;
    if (entry.refused) return undefined;
    const now = this.now();
    if (entry.name !== undefined && now < entry.usableUntil) return entry.name;
    if (entry.sightings >= 2 && !entry.creating && now >= entry.retryAfter) {
      this.start(entry, model, systemInstruction, tools, now, create);
    }
    return undefined;
  }

  /** The API refused a request that named this cache: its head is not cached again. */
  refuse(name: string): void {
    for (const entry of this.entries.values()) {
      if (entry.name !== name) continue;
      entry.name = undefined;
      entry.refused = true;
      this.refusals += 1;
    }
  }

  private start(
    entry: Entry,
    model: string,
    systemInstruction: unknown,
    tools: unknown,
    startedAt: number,
    create: GeminiPrefixCacheCreate,
  ): void {
    entry.creating = true;
    entry.name = undefined;
    const body = {
      model: `models/${model.replace(/^models\//u, "")}`,
      systemInstruction,
      tools,
      ttl: `${GEMINI_PREFIX_CACHE_TTL_MS / 1000}s`,
    };
    void (async () => {
      try {
        const name = await create(body);
        if (!name.startsWith("cachedContents/")) throw new Error("no cache name");
        if (entry.refused) return;
        entry.name = name;
        // Counted from before the request left, so never later than Google's clock.
        entry.usableUntil = startedAt + GEMINI_PREFIX_CACHE_USABLE_MS;
      } catch {
        // Too small for the model, unsupported, over quota or offline: the
        // requests keep carrying the head.
        entry.retryAfter = this.now() + GEMINI_PREFIX_CACHE_RETRY_MS;
      } finally {
        entry.creating = false;
      }
    })();
  }
}
