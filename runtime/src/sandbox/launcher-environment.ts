/**
 * Build the environment used by a process that must establish the sandbox
 * before any caller-controlled code can run.
 *
 * These variables can make a language runtime or the native loader execute
 * code before bubblewrap/seatbelt has installed isolation. They are therefore
 * never inherited by sandbox launchers. Ordinary variables (including PATH)
 * remain available to the command once the launcher has established policy.
 */
export function sanitizeSandboxLauncherEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isSandboxLauncherInjectionKey(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export function isSandboxLauncherInjectionKey(key: string): boolean {
  const upper = key.toUpperCase();
  return upper === "NODE_OPTIONS" ||
    upper === "NODE_PATH" ||
    upper === "ELECTRON_RUN_AS_NODE" ||
    upper === "BUN_OPTIONS" ||
    upper === "GCONV_PATH" ||
    upper === "LOCPATH" ||
    upper === "NLSPATH" ||
    upper === "MALLOC_TRACE" ||
    upper === "MALLOC_CHECK_" ||
    upper === "GLIBC_TUNABLES" ||
    upper === "LIBPATH" ||
    upper === "SHLIB_PATH" ||
    upper.startsWith("LD_") ||
    upper.startsWith("DYLD_");
}
