/**
 * API micro-compact request configuration.
 *
 * Source snapshot: `src/services/compact/apiMicrocompact.ts` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 */

export type ApiMicrocompactConfig = {
  readonly clearThinking?: boolean;
  readonly clearToolResults?: boolean;
  readonly clearToolUses?: boolean;
};

export function getAPIContextManagement(
  options: ApiMicrocompactConfig = {},
  env: Partial<Record<
    | "AGENC_MICROCOMPACT_CLEAR_THINKING"
    | "AGENC_MICROCOMPACT_CLEAR_TOOL_RESULTS"
    | "AGENC_MICROCOMPACT_CLEAR_TOOL_USES",
    string | undefined
  >> = process.env,
): ApiMicrocompactConfig | null {
  const config = {
    clearThinking:
      options.clearThinking === true ||
      isTruthy(env.AGENC_MICROCOMPACT_CLEAR_THINKING),
    clearToolResults:
      options.clearToolResults === true ||
      isTruthy(env.AGENC_MICROCOMPACT_CLEAR_TOOL_RESULTS),
    clearToolUses:
      options.clearToolUses === true ||
      isTruthy(env.AGENC_MICROCOMPACT_CLEAR_TOOL_USES),
  };
  return config.clearThinking || config.clearToolResults || config.clearToolUses
    ? config
    : null;
}

function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}
