import { scrubEnvForChildProcess } from "../unified-exec/scrub-env.js";

export function gitChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = scrubEnvForChildProcess(source);
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
      upper.startsWith("GIT_") ||
      upper.startsWith("SSH_ASKPASS") ||
      upper === "GCM_INTERACTIVE"
    ) {
      delete env[key];
    }
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_PROTOCOL_FROM_USER: "0",
    GCM_INTERACTIVE: "Never",
  };
}
