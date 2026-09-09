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
import { isAbsolute, relative, resolve } from "node:path";

import { isBashTool } from "../tools/concurrency.js";
import { SYSTEM_SEARCH_TOOLS_NAME } from "../tools/system/tool-search-name.js";
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
 * Tool discovery, which declares itself side-effecting but changes nothing.
 *
 * `system.searchTools` widens the turn's own advertised tool list and writes
 * nothing (its metadata says `virtualNoFsWrites`). It is marked
 * side-effecting for recovery purposes, so the read-only conjunction below
 * refuses it, and an unattended run is then unable to find the very tools it
 * is allowed to use: observed live, a routine burned its turn being refused
 * discovery and never produced a report. Loading a schema does not widen what
 * may actually run, because every non-builtin source is still refused when
 * the tool is called.
 */
const DISCOVERY_TOOLS = Object.freeze(new Set([SYSTEM_SEARCH_TOOLS_NAME]));

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
): { command: string; workdir?: string; unparsedOperands?: true } | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as {
    command?: unknown;
    cmd?: unknown;
    args?: unknown;
    workdir?: unknown;
    cwd?: unknown;
  };
  // system.bash keys it `command`; exec_command keys it `cmd`.
  const isExec = toolName === "exec_command";
  const raw = isExec ? record.cmd : record.command;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  // Each tool names its per-call working directory differently: `workdir` on
  // exec_command (tools/system/exec-command.ts), `cwd` on system.bash
  // (tools/system/bash.ts, applied unless lockCwd). Reading only `workdir`
  // left a system.bash override invisible to the folder check below.
  const override = isExec ? record.workdir : record.cwd;
  return {
    command: raw,
    ...(typeof override === "string" ? { workdir: override } : {}),
    // system.bash also has a direct mode that puts the operands in `args` and
    // execFiles them, so `cat` + ["/etc/passwd"] reaches both gates as the
    // bare word "cat": read-only, no path arguments, granted. The operands
    // are not in the string either gate parses, so the call is refused here.
    ...(!isExec && Array.isArray(record.args) && record.args.length > 0
      ? { unparsedOperands: true as const }
      : {}),
  };
}

/**
 * The run's own folder, named as a containment root for this one check.
 *
 * `checkPathConstraints` does not measure containment against the cwd it is
 * handed; that argument only says where a relative path argument resolves
 * from. The allowed roots come from `allWorkingDirectories`
 * (utils/permissions/filesystem.ts): the process-global `getOriginalCwd()`
 * plus `additionalWorkingDirectories`. In a daemon that hosts many sessions,
 * `getOriginalCwd()` is the folder the daemon itself was started in, never a
 * routine's project, and on the routine path the Map is empty. The file tools
 * do not have this problem, because their own path check
 * (permissions/path-validation.ts) adds the cwd it is handed to the root set;
 * this brings the shell gate to the same rule. Added to a copy, so the
 * session's context is left untouched.
 */
function withRunFolderAsRoot(
  cwd: string,
  context: ToolPermissionContext,
): ToolPermissionContext {
  if (context.additionalWorkingDirectories.has(cwd)) return context;
  const roots = new Map(context.additionalWorkingDirectories);
  roots.set(cwd, { path: cwd, source: "session" });
  return { ...context, additionalWorkingDirectories: roots };
}

/** `child` is `root` or sits under it. */
function pathIsInside(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function shellCallIsGranted(
  toolName: string,
  input: unknown,
  cwd: string | null,
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
  // A caller that cannot name the run's folder has nothing safe to put in its
  // place: every check below measures against it.
  if (cwd === null) {
    return { ok: false, reason: "this run has no folder of its own" };
  }
  if (parsed.unparsedOperands === true) {
    return { ok: false, reason: "its arguments are not part of the command" };
  }
  // A working directory of its own moves the ground the path check measures
  // against, so it has to stay inside the run's folder. A subdirectory is
  // legitimate and is where the command actually runs, so it becomes the base
  // the path arguments resolve from; anything outside is refused.
  const workdir =
    parsed.workdir === undefined ? resolve(cwd) : resolve(cwd, parsed.workdir);
  if (!pathIsInside(workdir, cwd)) {
    return { ok: false, reason: "it runs in a different folder" };
  }
  if (deps.checkReadOnly({ command: parsed.command }).behavior !== "allow") {
    return { ok: false, reason: "the command is not read-only" };
  }
  if (
    deps.checkPaths(
      { command: parsed.command },
      workdir,
      withRunFolderAsRoot(resolve(cwd), context),
    ).behavior !== "passthrough"
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
  cwd: string | null,
  context: ToolPermissionContext,
  deps: ShellGateDeps,
): ReadOnlyGrantVerdict {
  if (tool.name === "ExitPlanMode" || tool.name === "EnterPlanMode") {
    return { granted: false, refusal: { kind: "planHandoff" } };
  }
  if (NEVER_GRANTED.has(tool.name) || tool.requiresUserInteraction?.() === true) {
    return { granted: false, refusal: { kind: "interactive" } };
  }
  if (DISCOVERY_TOOLS.has(tool.name) && tool.metadata?.source === "builtin") {
    return GRANTED;
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
