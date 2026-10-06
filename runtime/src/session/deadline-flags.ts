/**
 * `agenc --deadline` and `--deadline-reserve` parsing (#2503).
 *
 * This module has no imports on purpose: `src/bin/route.ts` validates the flags
 * during the launcher startup preflight, and `scripts/check-launcher-preflight.mjs`
 * only admits a short allowlist of self-contained inputs into that bundle. The run
 * deadline itself lives in `./run-deadline.ts`, which re-exports these.
 *
 * @module
 */

export class DeadlineFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadlineFlagError";
  }
}

const RELATIVE_DEADLINE = /^\+(\d+(?:\.\d+)?)s?$/u;
const ISO_DEADLINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u;

/** `--deadline +<seconds>` or an ISO 8601 instant with a zone, as epoch ms. */
export function parseDeadlineFlag(value: string, nowMs: number): number {
  const trimmed = value.trim();
  const relative = RELATIVE_DEADLINE.exec(trimmed);
  let at: number;
  if (relative !== null) {
    at = nowMs + Math.round(Number(relative[1]) * 1000);
  } else if (ISO_DEADLINE.test(trimmed)) {
    at = Date.parse(trimmed);
  } else {
    throw new DeadlineFlagError(
      `agenc --deadline expects +<seconds> or an ISO 8601 instant with a time zone (got '${value}')`,
    );
  }
  if (!Number.isSafeInteger(at) || at <= nowMs) {
    throw new DeadlineFlagError(`agenc --deadline '${value}' is not in the future`);
  }
  return at;
}

/** `--deadline-reserve <seconds>` as ms. */
export function parseDeadlineReserveFlag(value: string): number {
  const seconds = Number(value.trim().replace(/s$/u, ""));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new DeadlineFlagError(
      `agenc --deadline-reserve expects a positive number of seconds (got '${value}')`,
    );
  }
  return Math.round(seconds * 1000);
}
