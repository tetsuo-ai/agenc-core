/**
 * Local _deps stub for the gut/AgenC crossing of
 * `../../../transport/sse-post.js`. Provider adapters only consume
 * `parseSSEFrames`; the rest of the SSETransport stays in the
 * AgenC port until the transport tranche replaces it.
 */

import { LLMInvalidResponseError } from "../errors.js";

/**
 * Hard cap on the un-delimited SSE remainder we will buffer waiting for a
 * frame separator. A single SSE event from these providers is realistically
 * well under a few MiB; this guards against a misbehaving provider/proxy that
 * streams bytes continuously without ever emitting a `\n\n` boundary, which
 * would otherwise grow the accumulation buffer to the full stream size in
 * memory (unbounded heap / OOM) without ever tripping the idle watchdog.
 */
export const MAX_SSE_FRAME_BYTES = 16 * 1024 * 1024;

export interface SSEFrame {
  event?: string;
  id?: string;
  data?: string;
}

/**
 * Separator pattern for the general (CR-bearing) path, hoisted to module
 * scope so it is not re-created on every call. `parseSSEFrames` is
 * synchronous and never re-entered while an `exec` scan is in flight, and
 * the scan always runs to a `null` result (which resets `lastIndex` to 0)
 * or throws only after such a result, so the shared pattern's `lastIndex`
 * is always 0 on entry; it is still reset explicitly for safety.
 */
const SEPARATOR_PATTERN = /\n\n|\r\n\r\n/g;

export function parseSSEFrames(
  buffer: string,
  providerName = "provider",
): {
  readonly frames: SSEFrame[];
  readonly remaining: string;
} {
  // Fast path: with no CR anywhere in the buffer, the general algorithm's
  // per-frame `replace(/\r/g, "")` is an identity, the only separator that
  // can occur is `\n\n`, and lines are exactly the `\n`-delimited spans.
  // Parse those frames in place: no separator RegExp, no whole-frame slice,
  // no line-array split — only the field and value strings the general
  // algorithm would produce are materialized. Any buffer containing a CR
  // (CRLF streams, stray CRs inside values) takes the original algorithm
  // verbatim below, so its semantics are unchanged by construction.
  if (buffer.indexOf("\r") === -1) {
    return parseLfOnlyFrames(buffer, providerName);
  }
  return parseGeneralFrames(buffer, providerName);
}

function parseLfOnlyFrames(
  buffer: string,
  providerName: string,
): {
  readonly frames: SSEFrame[];
  readonly remaining: string;
} {
  const frames: SSEFrame[] = [];
  let position = 0;

  while (true) {
    const separator = buffer.indexOf("\n\n", position);
    if (separator === -1) {
      const remaining = buffer.slice(position);
      if (remaining.length > MAX_SSE_FRAME_BYTES) {
        throw new LLMInvalidResponseError(
          providerName,
          `SSE stream exceeded ${MAX_SSE_FRAME_BYTES} bytes without a frame separator`,
        );
      }
      return { frames, remaining };
    }

    // A frame span with no ":" can yield no field and no comment line, so
    // the general algorithm would build an empty frame and drop it.
    const firstColon = buffer.indexOf(":", position);
    if (firstColon !== -1 && firstColon < separator) {
      const frame: SSEFrame = {};
      let isComment = false;
      let lineStart = position;
      while (lineStart < separator) {
        let lineEnd = buffer.indexOf("\n", lineStart);
        if (lineEnd === -1 || lineEnd > separator) lineEnd = separator;
        if (buffer.charCodeAt(lineStart) === 58 /* ":" */) {
          isComment = true;
        } else {
          const colon = buffer.indexOf(":", lineStart);
          if (colon !== -1 && colon < lineEnd) {
            const fieldLength = colon - lineStart;
            const isData =
              fieldLength === 4 && buffer.startsWith("data", lineStart);
            const isEvent =
              !isData &&
              fieldLength === 5 &&
              buffer.startsWith("event", lineStart);
            const isId =
              !isData &&
              !isEvent &&
              fieldLength === 2 &&
              buffer.startsWith("id", lineStart);
            if (isData || isEvent || isId) {
              let valueStart = colon + 1;
              if (
                valueStart < lineEnd &&
                buffer.charCodeAt(valueStart) === 32 /* " " */
              ) {
                valueStart += 1;
              }
              const value = buffer.slice(valueStart, lineEnd);
              if (isData) {
                frame.data = frame.data ? `${frame.data}\n${value}` : value;
              } else if (isEvent) {
                frame.event = value;
              } else {
                frame.id = value;
              }
            }
          }
        }
        if (lineEnd === separator) break;
        lineStart = lineEnd + 1;
      }

      if (frame.data !== undefined || isComment) {
        frames.push(frame);
      }
    }
    position = separator + 2;
  }
}

function parseGeneralFrames(
  buffer: string,
  providerName: string,
): {
  readonly frames: SSEFrame[];
  readonly remaining: string;
} {
  const frames: SSEFrame[] = [];
  let position = 0;
  // Search both accepted separators together. Two independent indexOf calls
  // rescan the whole suffix for the absent separator on every frame, making
  // a large chunk containing only LF frames quadratic in its frame count.
  const separators = SEPARATOR_PATTERN;
  separators.lastIndex = 0;

  while (true) {
    const separatorMatch = separators.exec(buffer);
    const separator = separatorMatch?.index ?? -1;
    if (separator === -1) {
      const remaining = buffer.slice(position);
      if (remaining.length > MAX_SSE_FRAME_BYTES) {
        throw new LLMInvalidResponseError(
          providerName,
          `SSE stream exceeded ${MAX_SSE_FRAME_BYTES} bytes without a frame separator`,
        );
      }
      return { frames, remaining };
    }
    const rawFrame = buffer.slice(position, separator).replace(/\r/g, "");
    position = separator + separatorMatch![0].length;
    if (rawFrame.trim().length === 0) {
      continue;
    }

    const frame: SSEFrame = {};
    let isComment = false;
    for (const line of rawFrame.split("\n")) {
      if (line.startsWith(":")) {
        isComment = true;
        continue;
      }
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const field = line.slice(0, colon);
      const rawValue = line.slice(colon + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") frame.event = value;
      if (field === "id") frame.id = value;
      if (field === "data") {
        frame.data = frame.data ? `${frame.data}\n${value}` : value;
      }
    }

    if (frame.data !== undefined || isComment) {
      frames.push(frame);
    }
  }
}
