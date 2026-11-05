/**
 * Which provider wires cache a prompt by its unchanged earlier content, and
 * where the query projection may keep every sent tool result unchanged. The
 * query projection, the inline image budget and the compaction shrink
 * measurement consult this, so it has no dependencies of its own.
 *
 * @module
 */

/** Provider wires whose cached prompt depends on unchanged earlier content. */
const PREFIX_CACHE_PROVIDERS: ReadonlySet<string> = new Set([
  "deepseek", "openai", "openai-compatible", "openrouter", "anthropic", "gemini", "grok",
]);

export function preservesQueryPrefix(provider: string | undefined): boolean {
  return provider !== undefined && PREFIX_CACHE_PROVIDERS.has(provider.trim().toLowerCase());
}

/**
 * Native DeepSeek keeps each sent tool result unchanged until durable
 * compaction instead of clearing old results with microcompaction. cch2
 * measured this on DeepSeek's 1M window with its automatic prefix cache.
 * Other providers keep the microcompaction valve, which also protects small
 * context windows and upstreams without a prompt cache.
 */
export function freezesToolResultsUntilCompaction(provider: string | undefined): boolean {
  return provider?.trim().toLowerCase() === "deepseek";
}
