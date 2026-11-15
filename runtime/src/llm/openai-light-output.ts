/**
 * Opt-in output savers for Light sessions on the `openai` provider, each behind its own name in
 * `AGENC_OPENAI_LIGHT_OUTPUT` (comma separated; `all` selects every one). With the variable unset no request
 * changes, and no other provider ever reads it.
 *
 * Why: in the 2026-11-15 same-wave A/B on gpt-6.1-terra and gpt-6.1-sol AgenC made fewer model calls than a rival
 * harness but wrote 25 to 28% more output tokens, and a call costs about 18 to 20 s per 1,000 output tokens. The
 * rollouts (round 4 job oaiout) show where the extra output and time go:
 *
 * - `exec-args`: GPT models write every presented exec_command field on every call. `workdir` (the absolute
 *   workspace path) and `background: false` were more than half of the characters of exec_command's arguments.
 *   With the switch a Light session's exec_command lists cmd and timeoutMs; the command still runs in the workspace
 *   root, and the hidden fields stay accepted and are named in the description.
 * - `no-summary`: the ChatGPT backend is asked for `reasoning.summary: "auto"` so a reasoning item can be replayed,
 *   and writes a summary line before the visible output of a call. With the switch the summary is not requested
 *   unless the user chose one.
 */
export const OPENAI_LIGHT_OUTPUT_ENV = "AGENC_OPENAI_LIGHT_OUTPUT";

export const OPENAI_LIGHT_OUTPUT_SWITCHES = ["exec-args", "no-summary"] as const;
export type OpenAiLightOutputSwitch = (typeof OPENAI_LIGHT_OUTPUT_SWITCHES)[number];

const NONE: ReadonlySet<OpenAiLightOutputSwitch> = new Set();

/** The switches a session's captured client environment turns on; empty for every provider but `openai`. */
export function openAiLightOutputSwitches(
  env: Readonly<Record<string, string | undefined>> | undefined,
  provider: string | undefined,
): ReadonlySet<OpenAiLightOutputSwitch> {
  if (provider !== "openai") return NONE;
  const value = env?.[OPENAI_LIGHT_OUTPUT_ENV];
  if (value === undefined || value.trim() === "") return NONE;
  const names = value.split(",").map((name) => name.trim().toLowerCase());
  if (names.includes("all")) return new Set(OPENAI_LIGHT_OUTPUT_SWITCHES);
  return new Set(OPENAI_LIGHT_OUTPUT_SWITCHES.filter((name) => names.includes(name)));
}

export function openAiLightOutputEnabled(
  env: Readonly<Record<string, string | undefined>> | undefined,
  provider: string | undefined,
  name: OpenAiLightOutputSwitch,
): boolean {
  return openAiLightOutputSwitches(env, provider).has(name);
}
