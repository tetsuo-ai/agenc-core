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

export function parseSSEFrames(
  buffer: string,
  providerName = "provider",
): {
  readonly frames: SSEFrame[];
  readonly remaining: string;
} {
  const frames: SSEFrame[] = [];
  let position = 0;
  // Search both accepted separators together. Two independent indexOf calls
  // rescan the whole suffix for the absent separator on every frame, making
  // a large chunk containing only LF frames quadratic in its frame count.
  const separators = /\n\n|\r\n\r\n/g;

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
