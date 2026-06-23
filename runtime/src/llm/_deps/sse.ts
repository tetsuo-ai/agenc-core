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

function findFrameSeparator(buffer: string, fromIndex: number): number {
  const lf = buffer.indexOf("\n\n", fromIndex);
  const crlf = buffer.indexOf("\r\n\r\n", fromIndex);
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

export function parseSSEFrames(
  buffer: string,
  providerName = "provider",
): {
  readonly frames: SSEFrame[];
  readonly remaining: string;
} {
  const frames: SSEFrame[] = [];
  let position = 0;

  while (true) {
    const separator = findFrameSeparator(buffer, position);
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
    position = separator + (buffer[separator] === "\r" ? 4 : 2);
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
