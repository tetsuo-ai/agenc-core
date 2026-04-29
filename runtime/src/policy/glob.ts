/**
 * Unified glob matcher (Cut 7.1).
 *
 * Single canonical implementation of glob / wildcard / regex matching
 * for tool permission rules. Replaces three near-identical glob
 * implementations:
 *   - `policy/engine.ts:matchToolPattern`
 *   - `gateway/tool-policy.ts:matchesPattern`
 *   - `gateway/approvals.ts:globMatch`
 *
 * Supports:
 *   - exact name              `Bash`
 *   - wildcard match-any      `Bash(*)`
 *   - prefix wildcard         `Bash(npm *)`
 *   - alternation             `Bash|Edit|Write`
 *   - regex                   wrapped in `/.../`
 *
 * The matcher is intentionally non-recursive — patterns may not nest
 * other patterns. The performance characteristic is O(pattern length)
 * per call so callers can hot-loop without caching.
 *
 * @module
 */

/**
 * Match a tool name + optional argument string against a permission rule
 * pattern. Examples:
 *
 *   matchToolPattern("Bash", { name: "Bash" })           // true
 *   matchToolPattern("Bash(git *)", { name: "Bash", arg: "git push" })  // true
 *   matchToolPattern("/^Tool/", { name: "ToolA" })       // true (regex)
 */
export function matchToolPattern(
  pattern: string,
  candidate: { name: string; arg?: string },
): boolean {
  if (!pattern) return false;

  // Regex form: /pattern/
  if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
    try {
      const re = new RegExp(pattern.slice(1, -1));
      return re.test(candidate.name) || (candidate.arg ? re.test(candidate.arg) : false);
    } catch {
      return false;
    }
  }

  // Alternation
  if (pattern.includes("|") && !pattern.includes("(")) {
    return pattern
      .split("|")
      .map((entry) => entry.trim())
      .some((entry) => matchToolPattern(entry, candidate));
  }

  // Tool(arg-pattern) form
  const parenMatch = /^([^()]+)\((.*)\)$/.exec(pattern);
  if (parenMatch) {
    const [, toolName = "", argPattern = ""] = parenMatch;
    if (toolName.trim() !== candidate.name) return false;
    return matchArgPattern(argPattern.trim(), candidate.arg ?? "");
  }

  // Plain tool-name match (with optional trailing wildcard).
  return matchPlain(pattern, candidate.name);
}

/**
 * Match an argument string against an arg-pattern. Supports `*` (any),
 * literal text, and a single trailing `*` for prefix matching.
 */
function matchArgPattern(pattern: string, arg: string): boolean {
  if (!pattern || pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return arg.startsWith(pattern.slice(0, -1));
  }
  return arg === pattern;
}

function matchPlain(pattern: string, candidate: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return candidate.startsWith(pattern.slice(0, -1));
  }
  return candidate === pattern;
}

/**
 * Generic glob match for a single value. Supports the same syntax as
 * `matchToolPattern` but extends `*` to be a free wildcard that can
 * appear anywhere in the pattern, for callers that need to match
 * hosts, channel names, identity IDs, and tool prefixes uniformly.
 * Empty pattern only matches an empty value.
 */
export function matchGlob(pattern: string, value: string): boolean {
  if (pattern === "" && value === "") return true;
  if (!pattern) return false;
  if (pattern === "*") return true;
  if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
    try {
      return new RegExp(pattern.slice(1, -1)).test(value);
    } catch {
      return false;
    }
  }
  if (pattern.includes("|")) {
    return pattern
      .split("|")
      .map((entry) => entry.trim())
      .some((entry) => matchGlob(entry, value));
  }
  if (!pattern.includes("*")) return value === pattern;
  // Multi-segment glob: split on `*` and walk segments left-to-right.
  const parts = pattern.split("*");
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  if (!value.startsWith(first)) return false;
  if (!value.endsWith(last)) return false;
  let cursor = first.length;
  for (let i = 1; i < parts.length - 1; i += 1) {
    const part = parts[i] ?? "";
    if (part.length === 0) continue;
    const next = value.indexOf(part, cursor);
    if (next === -1) return false;
    cursor = next + part.length;
  }
  return cursor <= value.length - last.length || parts.length === 1;
}
