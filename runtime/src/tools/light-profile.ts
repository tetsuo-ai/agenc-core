import { isEnvDefinedFalsy, isEnvTruthy } from "../utils/envBoolean.js";

/** Initial exposure only. Tool documentation, validation and execution stay canonical. */
export const LIGHT_INITIAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "system.searchTools",
  "FileRead",
  "Edit",
  "Write",
  "exec_command",
]);

/**
 * GPT-family Light sessions edit with apply_patch, the format those models are trained on: one patch
 * can create, change and remove files with several hunks, where Edit takes one replacement per call.
 * Edit and Write stay discoverable through system.searchTools.
 */
export const LIGHT_APPLY_PATCH_INITIAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "system.searchTools",
  "FileRead",
  "apply_patch",
  "exec_command",
]);

/** Providers whose Light sessions start with apply_patch instead of Edit and Write. */
export function lightEditsWithApplyPatch(providerName: string | undefined): boolean {
  return providerName === "openai";
}

/** `AGENC_LIGHT_TASK_LIMITS=1` or `=0` in the session environment overrides the provider default. */
export const LIGHT_TASK_LIMITS_ENV = "AGENC_LIGHT_TASK_LIMITS";

/**
 * Whether the Light head states the scope, check and report limits the standard head carries.
 * Without them DeepSeek Flash wrote larger files with unrequested handling, reran passing checks and
 * wrote long final reports: 83% more output and 156 s more provider time than standard over the race's
 * 22 tasks. Other providers keep the shorter Light workflow they were measured with.
 */
export function lightStatesTaskLimits(
  providerName: string | undefined,
  env: Readonly<Record<string, string | undefined>> = {},
): boolean {
  const value = env[LIGHT_TASK_LIMITS_ENV];
  if (isEnvDefinedFalsy(value)) return false;
  if (isEnvTruthy(value)) return true;
  return providerName === "deepseek";
}
