import { isEnvDefinedFalsy, isEnvTruthy } from "../utils/envBoolean.js";
import { modelFamilyFor } from "../llm/model-family.js";

/** The provider/model gate used for abliteration.ai Large V2 in cbee37540. */
export function lightUsesGlmTuning(providerName: string | undefined, model?: string): boolean {
  return providerName?.trim().toLowerCase() === "abliteration" &&
    model?.trim().toLowerCase() === "abliterated-model-large-v2";
}

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

/**
 * Light sessions on a GPT-family model start with apply_patch instead of Edit
 * and Write: OpenAI's own API, or a gateway serving the same model by its id
 * (OpenRouter `openai/gpt-6-luna`, Venice `openai-gpt-6-luna`). Native DeepSeek
 * Flash also uses the multi-file editor so one change can update source, tests
 * and documentation together. Other DeepSeek models/routes retain batch Edit
 * until measured; Edit and Write remain discoverable on every route.
 */
export function lightEditsWithApplyPatch(
  providerName: string | undefined,
  model?: string,
): boolean {
  return modelFamilyFor(providerName, model) === "openai" ||
    (providerName === "deepseek" && model?.trim().toLowerCase() === "deepseek-flash");
}

/** `AGENC_LIGHT_TASK_LIMITS=1` or `=0` in the session environment overrides the provider default. */
export const LIGHT_TASK_LIMITS_ENV = "AGENC_LIGHT_TASK_LIMITS";

/**
 * Whether the Light head states the scope, check and report limits the standard head carries.
 * Without them DeepSeek Flash wrote larger files with unrequested handling, reran passing checks and
 * wrote long final reports: 83% more output and 156 s more provider time than standard over the race's
 * 22 tasks. The default follows the model: DeepSeek's own API or a gateway serving a DeepSeek model
 * by its id. Other models keep the shorter Light workflow they were measured with.
 */
export function lightStatesTaskLimits(
  providerName: string | undefined,
  env: Readonly<Record<string, string | undefined>> = {},
  model?: string,
): boolean {
  const value = env[LIGHT_TASK_LIMITS_ENV];
  if (isEnvDefinedFalsy(value)) return false;
  if (isEnvTruthy(value)) return true;
  return modelFamilyFor(providerName, model) === "deepseek";
}

/** DeepSeek and abliteration.ai Large V2 Light sessions use batch Edit (#3163). */
export function lightUsesBatchEdit(providerName: string | undefined, model?: string): boolean {
  return modelFamilyFor(providerName, model) === "deepseek" || lightUsesGlmTuning(providerName, model);
}
