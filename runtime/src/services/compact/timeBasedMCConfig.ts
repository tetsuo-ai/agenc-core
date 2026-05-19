/**
 * Time-based micro-compact configuration.
 *
 * Source snapshot: `src/services/compact/timeBasedMCConfig.ts` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 */

export const DEFAULT_MICROCOMPACT_CLEAR_AFTER_MS = 5 * 60 * 1000;

type TimeBasedMicrocompactEnv = Partial<Record<
  "AGENC_MICROCOMPACT_CLEAR_AFTER_MS",
  string | undefined
>>;

export function getTimeBasedMicrocompactClearAfterMs(
  env: TimeBasedMicrocompactEnv = process.env,
): number {
  const raw = env.AGENC_MICROCOMPACT_CLEAR_AFTER_MS;
  if (raw === undefined) return DEFAULT_MICROCOMPACT_CLEAR_AFTER_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MICROCOMPACT_CLEAR_AFTER_MS;
}
