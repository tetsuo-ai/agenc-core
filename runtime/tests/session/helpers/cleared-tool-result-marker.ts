/**
 * Shared by the in-memory tool-result suites.
 *
 * Soak F74 / #2244: the in-memory bound no longer invents its own marker. It
 * adopts, byte for byte, whatever the request that just went out carried for
 * that tool result, so the next request reproduces the last one's prefix.
 * Under microcompact pressure that is microcompact's own marker; the bare
 * marker is written only for results before a compaction boundary, which no
 * future request carries at all. A test asserting "this result was cleared in
 * memory" must therefore accept either form.
 */

/** Written for results before a compaction boundary. */
export const CLEARED_MARKER = "[Old tool result content cleared]";

/** Written by microcompact in the outbound view, then adopted verbatim. */
export const MICROCOMPACT_MARKER_RE =
  /^\[microcompact:\d+\] Older tool output compressed; original length [\d,]+ characters\.$/;

export function isClearedToolResultMarker(text: string): boolean {
  return text === CLEARED_MARKER || MICROCOMPACT_MARKER_RE.test(text);
}
