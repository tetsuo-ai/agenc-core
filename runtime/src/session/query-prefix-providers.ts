/**
 * Which provider wires cache a prompt by its unchanged earlier content.
 * The query projection and the inline image budget both consult this, so
 * it has no dependencies of its own.
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
