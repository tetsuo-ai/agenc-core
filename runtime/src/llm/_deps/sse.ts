/**
 * Local _deps stub for the gut/openclaude crossing of
 * `../../../transport/sse-post.js`. Provider adapters only consume
 * `parseSSEFrames`; the rest of the SSETransport stays in the
 * openclaude port until the transport tranche replaces it.
 */

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

export function parseSSEFrames(buffer: string): {
  readonly frames: SSEFrame[];
  readonly remaining: string;
} {
  const frames: SSEFrame[] = [];
  let position = 0;

  while (true) {
    const separator = findFrameSeparator(buffer, position);
    if (separator === -1) {
      return { frames, remaining: buffer.slice(position) };
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
