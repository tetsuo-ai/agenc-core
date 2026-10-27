/** Decode bounded protocol error envelopes into human-readable text. */
export function readableToolError(raw: unknown, depth = 0): string {
  if (depth > 4) return "Tool execution failed";
  if (Array.isArray(raw)) {
    return raw.map(part => readableToolError(part, depth + 1)).join(" ");
  }
  if (raw !== null && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["error", "message", "content", "text"]) {
      if (Object.hasOwn(record, key) && record[key] !== undefined) {
        return readableToolError(record[key], depth + 1);
      }
    }
    const label = (value: unknown): string | undefined => {
      if (typeof value !== "string" && typeof value !== "number") return undefined;
      return String(value).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || undefined;
    };
    const kind = label(record.kind);
    const code = label(record.code);
    const details = [kind, code === undefined ? undefined : `code ${code}`].filter(Boolean);
    return details.length > 0 ? `Tool execution failed (${details.join(", ")})` : "Tool execution failed";
  }
  if (typeof raw !== "string") return "Tool execution failed";
  const trimmed = raw.trim();
  // Sandbox diagnostics begin with a bracketed reason, not a JSON array.
  const hasDiagnosticTag = /^\[[A-Za-z][A-Za-z0-9_-]*\](?:\s|$)/.test(trimmed);
  if (/^[\[{]/.test(trimmed) && !trimmed.startsWith("[exec ") && !hasDiagnosticTag) {
    try { return readableToolError(JSON.parse(trimmed), depth + 1); }
    catch { return "Tool execution failed"; }
  }
  return raw;
}

