/**
 * Hook matcher (Cut 5.2). Mirrors `claude_code/utils/hooks.ts:matchesPattern`.
 *
 * Supports:
 *   - exact name        `Bash`
 *   - wildcard          `*`
 *   - alternation       `Bash|Edit|Write`
 *   - regex             starts with `/...`/
 *
 * Tested independently of the dispatcher so the rules engine can grow.
 *
 * @module
 */

export function matchesHookMatcher(
  matcher: string | undefined,
  candidate: string,
): boolean {
  if (!matcher || matcher === "*") return true;
  if (matcher.startsWith("/") && matcher.endsWith("/")) {
    try {
      const re = new RegExp(matcher.slice(1, -1));
      return re.test(candidate);
    } catch {
      return false;
    }
  }
  if (matcher.includes("|")) {
    return matcher
      .split("|")
      .map((entry) => entry.trim())
      .some((entry) => entry === candidate);
  }
  return matcher === candidate;
}
