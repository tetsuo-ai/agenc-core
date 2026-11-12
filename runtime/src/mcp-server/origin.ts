/**
 * Grammar for the origins the inbound MCP HTTP/SSE transport admits.
 *
 * The transport compares a request's `Origin` header with configured entries
 * byte for byte, so an entry must already be written the way a client sends
 * it: a scheme, `://`, and a host with an optional port. Anything a client
 * never sends in that header (a path, a trailing slash, a wildcard, the
 * opaque `null` origin) is rejected here instead of silently never matching.
 * Pure and import-free so config validation can share it with the transport.
 */

const MCP_SERVER_ORIGIN_SHAPE = /^[a-z][a-z0-9+.-]*:\/\/[^\s/\\?#@*]+$/u;

const MCP_SERVER_ORIGIN_EXAMPLE = "http://localhost:5173";

export function mcpServerOriginValidationIssue(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return "must be a string";
  if (value.length === 0) return "must not be empty";
  if (!MCP_SERVER_ORIGIN_SHAPE.test(value)) {
    return (
      `must be an exact origin such as ${MCP_SERVER_ORIGIN_EXAMPLE}: a ` +
      "lowercase scheme and a host with an optional port, without a path, " +
      "trailing slash, credentials, or wildcard"
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `must be an exact origin such as ${MCP_SERVER_ORIGIN_EXAMPLE}`;
  }
  // Web origins have one serialized form (lowercase host, default port
  // omitted). Only that form can ever equal a browser's Origin header.
  if (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.origin !== value
  ) {
    return `must be written as ${parsed.origin}`;
  }
  return undefined;
}

/**
 * Freeze a validated, de-duplicated allowlist. Throws on the first entry the
 * grammar rejects, so a caller cannot construct a list that looks permissive
 * but never matches.
 */
export function normalizeMcpServerAllowedOrigins(
  origins: readonly unknown[],
): readonly string[] {
  const normalized = new Set<string>();
  for (const origin of origins) {
    const issue = mcpServerOriginValidationIssue(origin);
    if (issue !== undefined) {
      throw new Error(
        `MCP HTTP/SSE allowed origin ${JSON.stringify(origin)} ${issue}`,
      );
    }
    normalized.add(origin as string);
  }
  return Object.freeze([...normalized]);
}
