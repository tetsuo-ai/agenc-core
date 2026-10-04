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
