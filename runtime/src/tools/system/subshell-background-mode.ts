import { isEnvTruthy } from "../../utils/envBoolean.js";

/** Opt-in TB process guard. It changes dispatch only, never the tool schema. */
export function deepSeekSubshellBackgroundGuardEnabled(
  provider: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return provider === "deepseek" && isEnvTruthy(env.AGENC_DEEPSEEK_SUBSHELL_BACKGROUND_GUARD);
}
