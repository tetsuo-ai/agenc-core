/**
 * Which tool calls an unattended run may make without a human.
 *
 * A routine runs on a schedule with nobody attached, so an approval request
 * has no answer and the run parks until someone cancels it. This decides the
 * narrow set it may proceed on by itself: read the project, report, stop.
 *
 * It is deliberately NOT built on the repo's existing "read-only" predicates.
 * `toolDoesNotRequireApproval` accepts `requiresApproval === false`, and
 * `tagTool` stamps exactly that onto every tool whose name is not one of a
 * short list of builtins, so every MCP and plugin tool passes it. This asks
 * instead for the fail-closed conjunction already used to fence a ledger turn
 * (tools/router.ts, `ledgerTurnBlocksTool`), and then removes three families
 * that satisfy it on paper and not in fact.
 */
import { isBashTool } from "../tools/concurrency.js";
import type { ToolPermissionContext } from "./types.js";

/** The shape the evaluator sees. Kept structural so tests need no registry. */
export interface ReadOnlyGrantTool {
  readonly name: string;
  readonly isReadOnly?: boolean;
  readonly requiresApproval?: boolean;
  readonly recoveryCategory?: string;
  readonly metadata?: {
    readonly mutating?: boolean;
    readonly source?: string;
  };
  readonly requiresUserInteraction?: () => boolean;
}

/**
 * Declares itself read-only and is still not safe to run unwatched.
 *
 * - The network three ingest attacker-controllable text and carry repository
 *   content outward in a URL. `permissions/classifier.ts` already took them
 *   out of the auto allowlist for exactly this; a grant keyed on the flag
 *   would put them back.
 * - `Skill` is read-only only in the sense that loading a skill reads a file.
 *   What the skill then says is instruction text this run would follow.
 * - The plan tools and `AskUserQuestion` exist to reach a person. There is
 *   nobody to reach.
 */
const NEVER_GRANTED = Object.freeze(
  new Set([
    "web_fetch",
    "WebSearch",
    "XSearch",
    "Skill",
    "ExitPlanMode",
    "EnterPlanMode",
    "AskUserQuestion",
  ]),
);

/**
 * Shell that may run: read-only by command, and confined to the workspace.
 *
 * Two independent gates, both already load-bearing elsewhere.
 * `checkReadOnlyConstraints` decides that the command does not modify
 * anything; on its own it says yes to `cat ~/.ssh/id_rsa`, because "read-only"
 * there means "does not write", not "stays here". `checkPathConstraints`
 * supplies the second half: it extracts each path argument and answers `ask`
 * for anything outside the session's working directories. Requiring both is
 * what makes `git log` proceed and `cat ~/.agenc/wallet.json` stop.
 */
export type ShellGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface ShellGateDeps {
  readonly checkReadOnly: (input: { command: string }) => { behavior: string };
  readonly checkPaths: (
    input: { command: string },
    cwd: string,
    context: ToolPermissionContext,
  ) => { behavior: string };
}

/** Only these two run a command the model wrote. */
const GRANTABLE_SHELL_TOOLS = Object.freeze(
  new Set(["system.bash", "exec_command"]),
);

/** `write_stdin` feeds a running process; background bash outlives the run. */
export function shellToolIsGrantable(name: string): boolean {
  return GRANTABLE_SHELL_TOOLS.has(name);
}

export function readShellCommand(
  toolName: string,
  input: unknown,
): { command: string; workdir?: string } | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as { command?: unknown; cmd?: unknown; workdir?: unknown };
  // system.bash keys it `command`; exec_command keys it `cmd`.
  const raw = toolName === "exec_command" ? record.cmd : record.command;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return {
    command: raw,
    ...(typeof record.workdir === "string" ? { workdir: record.workdir } : {}),
  };
}

export function shellCallIsGranted(
  toolName: string,
  input: unknown,
  cwd: string,
  context: ToolPermissionContext,
  deps: ShellGateDeps,
): ShellGateResult {
  if (!shellToolIsGrantable(toolName)) {
    return { ok: false, reason: `${toolName} can affect a running process` };
  }
  const parsed = readShellCommand(toolName, input);
  if (parsed === null) {
    return { ok: false, reason: "the command could not be read" };
  }
  // A working directory of its own would move the ground the path check
  // measures against, so only the run's own folder is accepted.
  if (parsed.workdir !== undefined && parsed.workdir !== cwd) {
    return { ok: false, reason: "it runs in a different folder" };
  }
  if (deps.checkReadOnly({ command: parsed.command }).behavior !== "allow") {
    return { ok: false, reason: "the command is not read-only" };
  }
  if (
    deps.checkPaths({ command: parsed.command }, cwd, context).behavior !==
    "passthrough"
  ) {
    return { ok: false, reason: "it reads outside this project folder" };
  }
  return { ok: true };
}

/** Why a call was refused, in words the model can act on. */
export type ReadOnlyGrantRefusal =
  | { readonly kind: "planHandoff" }
  | { readonly kind: "interactive" }
  | { readonly kind: "source"; readonly source: string }
  | { readonly kind: "shell"; readonly reason: string }
  | { readonly kind: "mutating" };

export type ReadOnlyGrantVerdict =
  | { readonly granted: true }
  | { readonly granted: false; readonly refusal: ReadOnlyGrantRefusal };

const GRANTED: ReadOnlyGrantVerdict = Object.freeze({ granted: true });

/**
 * The fail-closed conjunction. Every clause must hold, and a tool that says
 * nothing about itself fails all three.
 */
function declaresItselfReadOnly(tool: ReadOnlyGrantTool): boolean {
  return (
    tool.isReadOnly === true &&
    tool.metadata?.mutating !== true &&
    tool.recoveryCategory === "idempotent"
  );
}

export function readOnlyGrantVerdict(
  tool: ReadOnlyGrantTool,
  input: unknown,
  cwd: string,
  context: ToolPermissionContext,
  deps: ShellGateDeps,
): ReadOnlyGrantVerdict {
  if (tool.name === "ExitPlanMode" || tool.name === "EnterPlanMode") {
    return { granted: false, refusal: { kind: "planHandoff" } };
  }
  if (NEVER_GRANTED.has(tool.name) || tool.requiresUserInteraction?.() === true) {
    return { granted: false, refusal: { kind: "interactive" } };
  }
  // An MCP or plugin tool describes itself, and that description arrives from
  // the server. `readOnlyHint` is advisory everywhere else in this codebase
  // and must not become authority here.
  const source = tool.metadata?.source;
  if (source !== "builtin") {
    return {
      granted: false,
      refusal: { kind: "source", source: source ?? "unknown" },
    };
  }
  if (isBashTool(tool.name)) {
    const shell = shellCallIsGranted(tool.name, input, cwd, context, deps);
    return shell.ok
      ? GRANTED
      : { granted: false, refusal: { kind: "shell", reason: shell.reason } };
  }
  return declaresItselfReadOnly(tool)
    ? GRANTED
    : { granted: false, refusal: { kind: "mutating" } };
}

/** One sentence the model can act on, and an operator can read in the log. */
export function readOnlyGrantRefusalMessage(
  toolName: string,
  refusal: ReadOnlyGrantRefusal,
): string {
  const tail =
    "This run has nobody attached to approve it. Do not retry. " +
    "Write what you found into your final answer instead.";
  switch (refusal.kind) {
    case "planHandoff":
      return `${toolName} hands a plan to a person for approval. ${tail}`;
    case "interactive":
      return `${toolName} needs a person. ${tail}`;
    case "source":
      return `${toolName} comes from ${refusal.source}, which this run cannot vet. ${tail}`;
    case "shell":
      return `That command was refused because ${refusal.reason}. ${tail}`;
    case "mutating":
      return `${toolName} can change things outside this report. ${tail}`;
  }
}
