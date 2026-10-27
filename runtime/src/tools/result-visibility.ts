/** Smallest model-aware cap for a complete inline tool result, in UTF-8 bytes. */
export const MIN_TOOL_RESULT_BYTES = 16_000;

/**
 * Optional inline-size threshold for the offload, in bytes
 * (`AGENC_TOOL_RESULT_OFFLOAD_BYTES`). When set and lower than the
 * model-aware cap, results above it are offloaded even though they would
 * have fit inline: the full output is persisted either way, so the only
 * effect is how much of the context window one tool result may occupy.
 * Unset or invalid keeps today's behavior (offload only above the cap).
 */
export function resolveOffloadThresholdBytes(): number | undefined {
  const raw = process.env.AGENC_TOOL_RESULT_OFFLOAD_BYTES;
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}
