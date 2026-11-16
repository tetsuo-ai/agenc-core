/**
 * Output savers for Light sessions on the `openai` provider (the platform API and ChatGPT sign-in), each under its
 * own name in `AGENC_OPENAI_LIGHT_OUTPUT` (comma separated). No other provider ever reads the variable.
 *
 * - `exec-args` (on by default since 0.19.36): GPT models write every presented exec_command field on every call.
 *   `workdir` (the absolute workspace path) and `background: false` were more than half of the characters of
 *   exec_command's arguments. A Light session's exec_command lists cmd and timeoutMs; the command still runs in
 *   the workspace root, and the hidden fields stay accepted and are named in the description.
 * - `no-summary` (opt-in): the ChatGPT backend is asked for `reasoning.summary: "auto"` so a reasoning item can be
 *   replayed, and writes a summary line before the visible output of a call. With the switch the summary is not
 *   requested unless the user chose one.
 *
 * The value adds to the defaults: unset is `exec-args`, `no-summary` is both, `all` is every switch. `off` (also
 * `none`, `0`, `false`, `no`) drops the defaults, so `off` alone restores the 0.19.35 requests and
 * `off,no-summary` is no-summary alone. Unknown names are ignored.
 *
 * Why: in the 2026-11-15 same-wave A/B on gpt-6.1-terra and gpt-6.1-sol AgenC made fewer model calls than a rival
 * harness but wrote 25 to 28% more output tokens, and a call costs about 18 to 20 s per 1,000 output tokens. With
 * `exec-args` alone the output fell 11.8% and the wall time 6.9% (85 pairs, p 0.001) with no solve lost (round 4
 * job oaiout, AB2). The gain of `no-summary` alone was not proven, so it stays opt-in.
 */
export const OPENAI_LIGHT_OUTPUT_ENV = "AGENC_OPENAI_LIGHT_OUTPUT";

export const OPENAI_LIGHT_OUTPUT_SWITCHES = ["exec-args", "no-summary"] as const;
export type OpenAiLightOutputSwitch = (typeof OPENAI_LIGHT_OUTPUT_SWITCHES)[number];

/** The switches that are on without the variable. */
export const OPENAI_LIGHT_OUTPUT_DEFAULTS: readonly OpenAiLightOutputSwitch[] = ["exec-args"];

const OFF_NAMES: ReadonlySet<string> = new Set(["off", "none", "0", "false", "no"]);
const NONE: ReadonlySet<OpenAiLightOutputSwitch> = new Set();
const DEFAULTS: ReadonlySet<OpenAiLightOutputSwitch> = new Set(OPENAI_LIGHT_OUTPUT_DEFAULTS);

/** The switches in effect for a session's captured client environment; empty for every provider but `openai`. */
export function openAiLightOutputSwitches(
  env: Readonly<Record<string, string | undefined>> | undefined,
  provider: string | undefined,
): ReadonlySet<OpenAiLightOutputSwitch> {
  if (provider !== "openai") return NONE;
  const value = env?.[OPENAI_LIGHT_OUTPUT_ENV];
  if (value === undefined || value.trim() === "") return DEFAULTS;
  const names = value.split(",").map((name) => name.trim().toLowerCase());
  if (names.includes("all")) return new Set(OPENAI_LIGHT_OUTPUT_SWITCHES);
  const withDefaults = !names.some((name) => OFF_NAMES.has(name));
  return new Set(OPENAI_LIGHT_OUTPUT_SWITCHES.filter((name) =>
    names.includes(name) || (withDefaults && DEFAULTS.has(name))));
}

export function openAiLightOutputEnabled(
  env: Readonly<Record<string, string | undefined>> | undefined,
  provider: string | undefined,
  name: OpenAiLightOutputSwitch,
): boolean {
  return openAiLightOutputSwitches(env, provider).has(name);
}
