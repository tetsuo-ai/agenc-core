import type { ProviderEnvironment } from "../../llm/provider-options.js";
import { EMPTY_MCP_REQUEST_ENVIRONMENT } from "../environment.js";
import { isChildTempAuthorityKey, subprocessEnv } from "../../utils/subprocessEnv.js";

export const DEFAULT_STDIO_ENV_VARS: readonly string[] =
  process.platform === "win32"
    ? ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PATHEXT",
        "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "USERNAME",
        "USERPROFILE", "PROGRAMFILES"]
    : ["HOME", "LOGNAME", "PATH", "SHELL", "USER", "__CF_USER_TEXT_ENCODING",
        "LANG", "LC_ALL", "TERM", "TZ"];

/** The exact environment passed to the stdio transport before its temp authority is added. */
export function createStdioMCPEnvironment(
  extraEnv: Readonly<Record<string, string>> | undefined,
  envVars: readonly string[] | undefined,
  parentEnv: ProviderEnvironment = EMPTY_MCP_REQUEST_ENVIRONMENT,
): Record<string, string> {
  const env: Record<string, string> = {};
  const sanitizedParent = subprocessEnv({ ...parentEnv });
  const names = new Set<string>(DEFAULT_STDIO_ENV_VARS);
  for (const name of envVars ?? []) {
    if (name.trim().length > 0) names.add(name);
  }
  for (const name of names) {
    if (isChildTempAuthorityKey(name)) continue;
    const value = sanitizedParent[name];
    if (value === undefined || value.startsWith("()")) continue;
    env[name] = value;
  }
  if (extraEnv !== undefined) Object.assign(env, extraEnv);
  for (const name of Object.keys(env)) {
    if (isChildTempAuthorityKey(name)) delete env[name];
  }
  return env;
}
