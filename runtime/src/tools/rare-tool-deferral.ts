/**
 * Deferral of built-in tools most sessions never call.
 *
 * Every advertised tool schema rides on every request. These tools are loaded
 * through system.searchTools like the other deferred tools instead, and the
 * system.searchTools description names them so the model knows they exist:
 *
 * - rarely used tools (under 2% of sessions in the Desktop test rollouts and
 *   the coding evals): the image, video, X search, LSP, notebook, Ledger, plan
 *   check and progress-note tools;
 * - the delegation tools: spawn_agent is selected when a task needs a helper,
 *   and the tools that only act on a spawned agent load with it;
 * - the process tools: they only act on a session exec_command left running,
 *   so they load by themselves when exec_command returns a live session_id.
 *
 * On by default in standard sessions; `defer_rare_tools = false` in
 * config.toml, or `AGENC_DEFER_RARE_TOOLS=0` in the session's environment
 * (which wins), advertises every tool again. Light sessions keep their own
 * initial tool set and only defer these when asked explicitly.
 *
 * @module
 */

import { isEnvDefinedFalsy, isEnvTruthy } from "../utils/envBoolean.js";

export const DEFER_RARE_TOOLS_ENV = "AGENC_DEFER_RARE_TOOLS";

/** Tool names, each with the few words the pointer uses to describe it. */
export const RARE_DEFERRED_TOOLS: ReadonlyArray<readonly [name: string, purpose: string]> = [
  ["ImagineImage", "generate or edit images"],
  ["ImagineVideo", "generate video"],
  ["XSearch", "search posts on X"],
  ["LSP", "definitions and references"],
  ["NotebookRead", "read Jupyter notebooks"],
  ["request_ledger_transfer", "Ledger transfer"],
  ["ledger_wallet_cli_status", "Ledger CLI status"],
  ["install_ledger_wallet_cli", "install the Ledger CLI"],
  ["VerifyPlanExecution", "check progress against a plan"],
  ["SendUserMessage", "progress note to the user"],
];

/**
 * Built-in tools a standard session starts without: each costs schema bytes on
 * every request and one search call on first use. On the race task GPT-6 Luna
 * spent 4 of 10 calls on responses that only updated TodoWrite, whatever the
 * prompt said, so the plan tool loads when long work needs it. exec_command
 * and Grep cover Orient's job. MultiEdit stays: without it DeepSeek made
 * several edits to one file one call at a time. Skill stays:
 * the skill listing names skills in every session, and a deferred Skill cost a
 * search call each time the model went for a listed skill. The question and
 * plan-mode tools load when needed; a session in plan mode sees
 * PLAN_MODE_TOOLS without a search.
 */
export const STANDARD_ON_DEMAND_TOOLS: ReadonlyArray<readonly [name: string, purpose: string]> = [
  ["TodoWrite", "a plan for long work"],
  ["Orient", "rank files for a question in a large repository"],
  ["web_fetch", "fetch a web page"],
  ["WebSearch", "search the web"],
  ["report_agent_job_result", "CSV job worker result"],
  ["AskUserQuestion", "multiple-choice question to the user"],
  ["EnterPlanMode", "plan a large change first"],
  ["ExitPlanMode", "present a plan for approval"],
];

/** Deferred tools a session in plan mode always sees: it plans, asks and asks for approval. */
export const PLAN_MODE_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** The delegation entry point; selecting it also loads its companions. */
export const DELEGATION_ENTRY_TOOL = "spawn_agent";

/** Tools that only act on an agent spawn_agent started. */
export const DELEGATION_COMPANION_TOOLS: readonly string[] = [
  "wait_agent",
  "send_message",
  "assign_task",
  "close_agent",
  "list_agents",
];

/** Tools that only act on a session exec_command left running. */
export const PROCESS_SESSION_TOOLS: readonly string[] = [
  "write_stdin",
  "kill_process",
  "list_processes",
];

const RARE_DEFERRED_TOOL_NAMES: ReadonlySet<string> = new Set(
  RARE_DEFERRED_TOOLS.map(([name]) => name),
);

const STANDARD_DEFERRED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...RARE_DEFERRED_TOOL_NAMES,
  ...STANDARD_ON_DEMAND_TOOLS.map(([name]) => name),
  DELEGATION_ENTRY_TOOL,
  ...DELEGATION_COMPANION_TOOLS,
  ...PROCESS_SESSION_TOOLS,
]);

/**
 * Whether the session environment defers these tools. The bootstrap passes
 * the environment the session captured, so a client sets it per session; the
 * daemon's own process environment does not decide it. Unset means on for
 * standard sessions and off for Light sessions.
 */
export function rareToolDeferralEnabled(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    readonly lightMode?: boolean;
    /** config.toml `defer_rare_tools`; the session environment overrides it. */
    readonly configured?: boolean;
  } = {},
): boolean {
  const value = env[DEFER_RARE_TOOLS_ENV];
  if (isEnvDefinedFalsy(value)) return false;
  if (isEnvTruthy(value)) return true;
  if (typeof options.configured === "boolean") return options.configured;
  return options.lightMode !== true;
}

/** One of the rarely used tools (the list a Light session defers on request). */
export function isRareDeferredTool(name: string): boolean {
  return RARE_DEFERRED_TOOL_NAMES.has(name);
}

/** A tool a standard session defers: the rare tools, delegation and process tools. */
export function isStandardDeferredTool(name: string): boolean {
  return STANDARD_DEFERRED_TOOL_NAMES.has(name);
}

/**
 * The names a selection loads: spawn_agent brings the tools that act on the
 * agents it starts, so a delegating turn needs one search, not several.
 */
export function withDeferredCompanions(names: readonly string[]): readonly string[] {
  const companions = [
    ...(names.includes(DELEGATION_ENTRY_TOOL) ? DELEGATION_COMPANION_TOOLS : []),
    ...(names.includes("spawn_agents_on_csv") ? ["report_agent_job_result"] : []),
  ];
  return companions.length === 0 ? names : [...new Set([...names, ...companions])];
}

/**
 * The lines naming the deferred tools present in this registry, appended to
 * the system.searchTools description. They cover the whole session, loaded or
 * not, so the description does not change when one is loaded.
 */
export function rareToolPointer(
  presentNames: ReadonlySet<string>,
  options: { readonly standard?: boolean } = {},
): string | undefined {
  const lines: string[] = [];
  if (options.standard === true && presentNames.has(DELEGATION_ENTRY_TOOL)) {
    const companions = DELEGATION_COMPANION_TOOLS.filter((name) => presentNames.has(name));
    lines.push(
      `To hand a self-contained task to a helper agent, load ${DELEGATION_ENTRY_TOOL} with select:${DELEGATION_ENTRY_TOOL}` +
        (companions.length > 0 ? `; it loads ${companions.join(", ")} with it.` : "."),
    );
  }
  // The process tools load by themselves when exec_command leaves a session
  // running, and exec_command's description names them; the pointer does not.
  const present = [
    ...(options.standard === true ? STANDARD_ON_DEMAND_TOOLS : []),
    ...RARE_DEFERRED_TOOLS,
  ].filter(([name]) => presentNames.has(name));
  if (present.length > 0) {
    lines.push(`Deferred tools you can load with select: ${present
      .map(([name, purpose]) => `${name} (${purpose})`)
      .join(", ")}.`);
  }
  return lines.length === 0 ? undefined : lines.join("\n");
}
