/**
 * System prompt section registry — cache-separation pattern.
 *
 * Port of AgenC `constants/systemPromptSections.ts` (69 LOC).
 *
 * Two section factories:
 *
 *   - `systemPromptSection(id, compute)` — memoized: compute runs once,
 *     result lives in the module-local cache until `clearSystemPromptSections()`
 *     (which is called from `/clear` and `/compact`). Use for static or
 *     deterministic content where "same inputs → same output".
 *
 *   - `DANGEROUS_uncachedSystemPromptSection(id, compute, reason)` — volatile:
 *     recompute every resolve, invalidate any matching cache entry each time.
 *     Use for content that can change mid-session (MCP servers connecting /
 *     disconnecting, token budgets flipping, etc.). Cache-breaking content
 *     MUST live after `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`.
 *
 * Storage is a single module-level `Map<id, string|null>` — the cache is
 * process-local and not keyed by session, matching AgenC behavior.
 * `clearSystemPromptSections()` wipes the whole map.
 *
 * @module
 */

type ComputeFn = () => string | null | Promise<string | null>;

export interface SystemPromptSection {
  readonly name: string;
  readonly compute: ComputeFn;
  /** true → recompute every resolve, even when cached. */
  readonly cacheBreak: boolean;
}

// Module-local cache. Wiped by `clearSystemPromptSections()` (wired from
// `/clear` and `/compact`). `null` is a valid cached value and means
// "section compute returned null, skip rendering it".
const cache = new Map<string, string | null>();

/**
 * Declare a memoized system prompt section. The `compute` fn runs at most
 * once between cache clears. Return `null` from `compute` to skip the
 * section entirely (it will still be cached as "absent").
 */
export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false };
}

/**
 * Declare a volatile, cache-breaking system prompt section. Every resolve
 * recomputes, and any stale entry is evicted from the cache.
 *
 * `reason` is documentation only — it forces callers to state why cache-
 * breaking is necessary. Reasons show up in code review, not at runtime.
 */
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true };
}

/**
 * Resolve each section to a string-or-null. Cached sections hit the
 * process-local cache; volatile sections recompute and overwrite any
 * stale cached value.
 */
export async function resolveSystemPromptSections(
  sections: readonly SystemPromptSection[],
): Promise<(string | null)[]> {
  return Promise.all(
    sections.map(async (s) => {
      if (!s.cacheBreak && cache.has(s.name)) {
        return cache.get(s.name) ?? null;
      }
      const value = await s.compute();
      cache.set(s.name, value);
      return value;
    }),
  );
}

/**
 * Wipe the whole cache. Called from `/clear` and `/compact` so a fresh
 * session sees fresh section evaluation.
 */
export function clearSystemPromptSections(): void {
  cache.clear();
}

/**
 * Test-only peek at the current cache size. Not exported from the prompts
 * barrel; consumers outside tests should not depend on this.
 */
export function __systemPromptSectionCacheSize(): number {
  return cache.size;
}

/**
 * Test-only peek at a cache entry. Returns `undefined` when unseen, or
 * the cached value (which can itself be `null`).
 */
export function __peekSystemPromptSection(name: string): string | null | undefined {
  return cache.get(name);
}
