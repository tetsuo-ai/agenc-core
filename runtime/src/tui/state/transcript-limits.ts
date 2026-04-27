/**
 * TUI-only transcript retention bounds.
 *
 * These helpers protect the live React/Ink transcript from retaining full
 * tool payloads that already exist in the rollout log and model history.
 * The model-facing cleanup follows openclaude's persisted-output path; this
 * file is only for display state.
 */

export const TUI_TRANSCRIPT_MAX_OUTPUT_CHARS = 64_000;
export const TUI_TRANSCRIPT_MAX_ARG_CHARS = 24_000;
export const TUI_TRANSCRIPT_MAX_ARG_STRING_CHARS = 8_000;
export const TUI_TRANSCRIPT_OMISSION_LABEL = "omitted from TUI transcript";

function omissionMarker(omittedChars: number): string {
  return `\n...[${omittedChars} chars ${TUI_TRANSCRIPT_OMISSION_LABEL}]...\n`;
}

export function truncateTranscriptText(
  value: string,
  maxChars = TUI_TRANSCRIPT_MAX_OUTPUT_CHARS,
): string {
  if (value.length <= maxChars) return value;
  const placeholder = omissionMarker(value.length - maxChars);
  if (placeholder.length >= maxChars) return value.slice(0, maxChars);
  const remaining = maxChars - placeholder.length;
  const head = Math.ceil(remaining * 0.6);
  const tail = remaining - head;
  const omitted = value.length - head - tail;
  return `${value.slice(0, head)}${omissionMarker(omitted)}${value.slice(
    value.length - tail,
  )}`;
}

export function appendBoundedTranscriptText(
  prior: string,
  next: string,
  maxChars = TUI_TRANSCRIPT_MAX_OUTPUT_CHARS,
): string {
  if (prior.length === 0) return truncateTranscriptText(next, maxChars);
  if (next.length === 0) return prior;
  return truncateTranscriptText(`${prior}${next}`, maxChars);
}

export function appendBoundedTranscriptLine(
  prior: string,
  next: string,
  maxChars = TUI_TRANSCRIPT_MAX_OUTPUT_CHARS,
): string {
  if (prior.length === 0) return truncateTranscriptText(next, maxChars);
  if (next.length === 0) return prior;
  return truncateTranscriptText(`${prior}\n${next}`, maxChars);
}

function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateTranscriptText(value, TUI_TRANSCRIPT_MAX_ARG_STRING_CHARS);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry));
  }
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = sanitizeJsonValue(entry);
    }
    return next;
  }
  return value;
}

export function truncateTranscriptJsonArgs(args: string): string {
  if (args.length <= TUI_TRANSCRIPT_MAX_ARG_CHARS) return args;
  try {
    const parsed = JSON.parse(args);
    const sanitized = JSON.stringify(sanitizeJsonValue(parsed));
    if (sanitized.length <= TUI_TRANSCRIPT_MAX_ARG_CHARS) return sanitized;
    return JSON.stringify({
      truncated: truncateTranscriptText(sanitized, TUI_TRANSCRIPT_MAX_ARG_CHARS),
    });
  } catch {
    return truncateTranscriptText(args, TUI_TRANSCRIPT_MAX_ARG_CHARS);
  }
}
