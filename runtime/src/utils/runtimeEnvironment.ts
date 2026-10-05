type CoreOnlyEnvironmentKey = "AGENC_ONBOARDING" | "AGENC_DAEMON_AUTOSTART_FAILURE";
const coreOnlyOverrides = new Map<CoreOnlyEnvironmentKey, {
  original: string | undefined;
  applied: string;
}>();

/** Record CLI-only state without changing the environment seen by user tools. */
export function setCoreOnlyEnvironmentVariable(key: CoreOnlyEnvironmentKey, value: string): void {
  const original = coreOnlyOverrides.has(key)
    ? coreOnlyOverrides.get(key)!.original
    : process.env[key];
  coreOnlyOverrides.set(key, { original, applied: value });
  process.env[key] = value;
}

/** Restore user environment values replaced by Core's own bootstrap defaults.
 * The import-free process entries capture these before loading any bundle chunks.
 * No environment marker is exported to user commands, and repeated bootstrap
 * imports cannot overwrite the original snapshot.
 */
export function userRuntimeEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const original = (globalThis as typeof globalThis & {
    [key: symbol]: Readonly<{ NODE_ENV: string | undefined }> | undefined;
  })[Symbol.for("agenc.originalRuntimeEnvironment")];
  const result = { ...environment };
  // Only undo Core's default; an explicitly inherited production value wins.
  // Per-command overrides are applied after restoring the base environment.
  if (original !== undefined && original.NODE_ENV === undefined && result.NODE_ENV === "production") {
    delete result.NODE_ENV;
  }
  for (const [key, { original, applied }] of coreOnlyOverrides) {
    if (result[key] !== applied) continue;
    if (original === undefined) delete result[key];
    else result[key] = original;
  }
  return result;
}
