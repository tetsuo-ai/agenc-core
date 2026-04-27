/**
 * Lean re-implementation of the tool-result capping helpers
 * `rollout-reconstruction.ts` uses to bound replayed tool output size.
 *
 * `tools/execution.ts` lives in the AgenC port and bundles the
 * full execution orchestrator. The gut session code only needs the
 * size cap + the I-15 byte limit, so they are reproduced here as a
 * narrow, dependency-free surface that survives AgenC deletion.
 */

/**
 * I-15: default cap on tool result size in bytes. 400 KB matches
 * AgenC `MAX_TOOL_RESULT_TOKENS=100_000 × BYTES_PER_TOKEN=4`.
 */
export const DEFAULT_MAX_TOOL_RESULT_BYTES = 400_000;

const TRUNCATION_MARKER_TEMPLATE =
  "\n\n[truncated: original was {ORIG} bytes, returning first {KEPT}]\n";

export function capToolResult(
  content: string,
  maxBytes: number,
): {
  readonly capped: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
} {
  const originalBytes = Buffer.byteLength(content, "utf8");
  if (originalBytes <= maxBytes) {
    return { capped: content, truncated: false, originalBytes };
  }
  const marker = TRUNCATION_MARKER_TEMPLATE
    .replace("{ORIG}", String(originalBytes))
    .replace("{KEPT}", String(maxBytes));
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const keepBytes = Math.max(0, maxBytes - markerBytes);
  const buf = Buffer.from(content, "utf8");
  const kept = buf.subarray(0, keepBytes).toString("utf8");
  return { capped: `${kept}${marker}`, truncated: true, originalBytes };
}
