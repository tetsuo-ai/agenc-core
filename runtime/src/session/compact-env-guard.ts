/**
 * DAE-01: compact temporarily stamps provider-override keys onto process.env
 * (read by compact services via AGENC_USE_OPENAI / OPENAI_*). All installers
 * (run-turn auto-compact and /compact session-compact) share one serialized
 * gate so concurrent same-process work cannot interleave credentials.
 */

export const COMPACT_CONTEXT_GUARD_ENV = [
  "AGENC_USE_OPENAI",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW",
] as const;

export type CompactGuardEnv = Partial<
  Record<(typeof COMPACT_CONTEXT_GUARD_ENV)[number], string>
>;

/** Module-level chain: next waiter runs only after previous finally releases. */
let compactEnvGate: Promise<void> = Promise.resolve();

/**
 * Install `env` onto process.env for the duration of `fn`, then restore.
 * Concurrent callers are serialized through {@link compactEnvGate}.
 */
export async function withCompactContextGuards<T>(
  fn: () => Promise<T>,
  env: CompactGuardEnv = {},
): Promise<T> {
  let release!: () => void;
  const previousGate = compactEnvGate;
  compactEnvGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previousGate;
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env) as Array<keyof CompactGuardEnv>) {
    previous.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    release();
  }
}
