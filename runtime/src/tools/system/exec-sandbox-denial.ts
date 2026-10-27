/**
 * Turn an OS-level sandbox refusal into a statement the model can act on.
 *
 * A sandbox denial that happens at syscall time inside a running child never
 * reaches the runtime as a denial: the child simply exits non-zero and its
 * own errno text is the only thing the tool result carries. The model sees
 * `Error: listen EPERM: operation not permitted 0.0.0.0:8080` and nothing
 * that says the sandbox did it, that the command itself is fine, or that
 * retrying is pointless. Live incident (session conv-mtjdmlfc, 2026-09-02):
 * a model retried one denied `npm start` 21 times over 412 seconds, raising
 * the timeout and rewording a justification nobody could answer, because
 * nothing in the transcript told it the retry could not work.
 *
 * This module classifies listening socket and Git metadata refusals and
 * returns a frozen sentence to append to the tool result, worded for how the
 * session answers a retry outside the sandbox (SandboxEscalationGrant). The
 * text is deliberately constant: the repeated-failure guard compares failure
 * signatures, so a notice that embedded a timing or a port would defeat the
 * very guard that catches a model which keeps going anyway.
 *
 * @module
 */

import { LOCAL_BINDING_GUIDANCE } from "./local-server-guidance.js";
import { isLightPrintRun } from "../../prompts/light-print.js";
import { escalationStaysConfined } from "../../sandbox/escalation/confinement.js";
import { routineRunOptions } from "../../session/runtime-options.js";
import { asRecord } from "../../utils/record.js";

/** The denial classes this module recognizes. */
export type ExecSandboxDenialKind = "network_bind" | "git_write";

/**
 * How this session answers a request to run one command outside the sandbox
 * (`sandbox_permissions: "require_escalated"`), so a notice offers only what
 * can happen and in the words that fit:
 * - `without_asking`: bypassPermissions grants it without a card
 *   (tools/orchestrator.ts), as its prompt says (prompts/permissions-prompt.ts);
 * - `with_approval`: a person approves it on a card;
 * - `unavailable`: nobody can grant it in this session.
 */
export type SandboxEscalationGrant = "without_asking" | "with_approval" | "unavailable";

/**
 * Git's ref-directory failure omits errno entirely. Other errors are git's own
 * refusal to write a .git path, naming the path and the refusal. Existing
 * locks, invalid refs, running a hook and other programs writing into .git
 * stay out: those do not establish that the sandbox refused a git operation.
 */
const GIT_WRITE_DENIED_SIGNATURES: readonly RegExp[] = [
  /^fatal: cannot lock ref '[^'\n]+': unable to create directory for [^\n]*\.git[\\/]refs[\\/]/imu,
  /^(?:fatal|error): (?=[^\n]*\.git[\\/](?:index(?:\.lock)?|HEAD(?:\.lock)?|COMMIT_EDITMSG|refs[\\/]|logs[\\/]|objects(?:[\\/\s]|$)))[^\n]*(?:read-only file system|permission denied|operation not permitted)/imu,
  /^error: insufficient permission for adding an object to repository database [^\n]*\.git[\\/]objects\b/imu,
  // Git's own write to the metadata that stays protected when the rest of
  // .git is writable: config (`git config`, `git remote add`), worktrees,
  // modules, info. Device or resource busy is git renaming its lock file onto
  // a read-only bind of `.git/config`. Running a hook, or another program
  // writing into .git, never matches.
  /^(?:fatal|error): (?:could not|unable to|cannot|failed to) (?:lock|write|create|commit|open|rename|append|update)\b[^\n]*\.git[\\/][^\n]*: (?:read-only file system|permission denied|operation not permitted|device or resource busy)\.?[ \t]*$/imu,
  // A submodule clone names its new git directory before its fatal line.
  /^\/[^\s:]*\/\.git\/modules\/[^\s:]*: (?:read-only file system|permission denied|operation not permitted)[ \t]*$/imu,
];

/** The command line runs git, so a git refusal in its output is its own, whatever the shell's exit status. */
const RUNS_GIT = /(?:^|[\s;&|(`/])git(?=\s)/u;

/**
 * A person approves the retry on a card. The approval covers this command
 * only: no prefix_rule, so nothing is offered for later commands.
 */
export const SANDBOX_GIT_WRITE_DENIED_ESCALATION_AVAILABLE =
  '[sandbox] Git could not write protected .git metadata. If the user asked for this git operation, retry it once with sandbox_permissions="require_escalated" and a justification asking approval for only this command; omit prefix_rule. ' +
  "Do not write .git files directly, or change hooks, config or sandbox settings to work around the refusal.";

/** Bypass grants the retry without a card, so the notice asks for no approval. */
export const SANDBOX_GIT_WRITE_DENIED_WITHOUT_ASKING =
  '[sandbox] Git could not write protected .git metadata. If the user asked for this git operation, retry it once with sandbox_permissions="require_escalated" and a one-line justification; approvals are off in this session, so it runs outside the sandbox without asking. ' +
  "Do not write .git files directly, or change hooks, config or sandbox settings to work around the refusal.";

export const SANDBOX_GIT_WRITE_DENIED_NO_ESCALATION =
  "[sandbox] Git could not write protected .git metadata. Escalation is unavailable in this session; ask the user to run the requested git operation in their terminal. Do not retry unchanged, write .git files directly, or change sandbox protection.";

/**
 * Signatures of "the OS refused to bind or listen", across the runtimes a
 * coding agent actually starts a server with. Require a bind/listen operation
 * and a permission errno, or Python's server socket construction followed by
 * its permission traceback. A bare EPERM (chmod, kill, write, client socket
 * creation) is a different failure and must not be labelled a server denial.
 */
const BIND_DENIED_SIGNATURES: readonly RegExp[] = [
  // Node: "Error: listen EPERM: operation not permitted 0.0.0.0:8080"
  /\b(?:listen|bind)\s+(?:EPERM|EACCES)\b/u,
  // Go / Rust / Python: "bind: operation not permitted",
  // "listen tcp 0.0.0.0:8080: bind: permission denied"
  /\b(?:bind|binding|listen|listening)\b[^\n]{0,80}?(?:operation not permitted|permission denied)/iu,
  // Reversed order: "... PermissionDenied ... binding 0.0.0.0:3000"
  /(?:operation not permitted|permission denied)[^\n]{0,80}?\b(?:bind|binding|listen|listening)\b/iu,
  // Python http.server can fail at socket creation, before server_bind.
  // Its errno lives below the source/caret lines and the socket.py frame.
  /\bself\.socket = socket\.socket\([^\n]*\n(?:[^\n]*\n){0,5}PermissionError: \[Errno (?:1|13)\] (?:operation not permitted|permission denied)\b/iu,
  // Python's bind traceback also puts the errno on a separate line.
  /\bself\.socket\.bind\([^\n]*\n(?:[ \t]+[~^]+\n)?PermissionError: \[Errno (?:1|13)\] (?:operation not permitted|permission denied)\b/iu,
];

/**
 * Escalation cannot be granted by anyone in this session, so the only honest
 * next step is to hand the command to the user.
 */
export const SANDBOX_BIND_DENIED_NO_ESCALATION =
  "[sandbox] The sandbox blocks local servers. Do not run this command again unchanged. " +
  "Escalation is unavailable; ask the user to run it in their terminal. " + LOCAL_BINDING_GUIDANCE;

/**
 * A human can still approve, so one escalated retry is the correct move —
 * and exactly one, because a second identical request answers nothing.
 */
export const SANDBOX_BIND_DENIED_ESCALATION_AVAILABLE =
  "[sandbox] The sandbox blocks local servers. Explain that you will start the preview and give its URL. " +
  "Retry this command once with sandbox_permissions=\"require_escalated\" and a plain-language justification asking to start a preview the user can open in their browser. " +
  "A persistent server can use detach=true on that approved launch; otherwise keep it in the foreground with yield_time_ms. " +
  LOCAL_BINDING_GUIDANCE + " Check an escalated server's URL with the same sandbox_permissions, since sandbox loopback may be isolated.";

/** Bypass grants the retry without a card: no approval to ask for. */
export const SANDBOX_BIND_DENIED_WITHOUT_ASKING =
  "[sandbox] The sandbox blocks local servers. Explain that you will start the preview and give its URL. " +
  "Retry this command once with sandbox_permissions=\"require_escalated\" and a one-line justification; approvals are off in this session, so it runs outside the sandbox without asking. " +
  "A persistent server can use detach=true on that escalated launch; otherwise keep it in the foreground with yield_time_ms. " +
  LOCAL_BINDING_GUIDANCE + " Check an escalated server's URL with the same sandbox_permissions, since sandbox loopback may be isolated.";

/**
 * The notice for a finished exec, or null when this was not a sandbox
 * denial. Requires that a sandbox was actually applied: without one the
 * same errno means the OS itself refused (a privileged port, a taken
 * address), which is the user's problem, not the sandbox's, and mislabeling
 * it would send the model down the wrong path. `advisesEscalation` says the
 * notice tells the model to retry with sandbox_permissions, so the caller
 * presents that field on the next request.
 */
export function execSandboxDenialNotice(params: {
  readonly output: string;
  readonly exitCode: number | null;
  /**
   * The shell command, when known. A refused git write followed by a pipe to
   * tail or a `;` exits 0: when the command runs git, its refusal still counts.
   */
  readonly command?: string;
  readonly sandboxApplied: boolean;
  /** How a retry outside the sandbox would be answered (sandboxEscalationGrant). */
  readonly escalation?: SandboxEscalationGrant;
  /** Older callers: true means a person can approve the retry. */
  readonly escalationAvailable?: boolean;
  readonly session?: unknown;
}): {
  readonly kind: ExecSandboxDenialKind;
  readonly notice: string;
  readonly advisesEscalation: boolean;
} | null {
  if (!params.sandboxApplied) return null;
  const grant = params.escalation ??
    (params.escalationAvailable === true ? "with_approval" : "unavailable");
  if (
    (params.exitCode !== 0 || (params.command !== undefined && RUNS_GIT.test(params.command))) &&
    GIT_WRITE_DENIED_SIGNATURES.some((pattern) => pattern.test(params.output))
  ) {
    // A delegated agent's escalated command keeps its confinement, so the
    // retry would hit the same protected metadata.
    const gitGrant = escalationStaysConfined(params.session) ? "unavailable" : grant;
    return {
      kind: "git_write",
      notice: gitGrant === "without_asking"
        ? SANDBOX_GIT_WRITE_DENIED_WITHOUT_ASKING
        : gitGrant === "with_approval"
          ? SANDBOX_GIT_WRITE_DENIED_ESCALATION_AVAILABLE
          : SANDBOX_GIT_WRITE_DENIED_NO_ESCALATION,
      advisesEscalation: gitGrant !== "unavailable",
    };
  }
  // A background server can fail even when its shell exits zero after curl,
  // cleanup or an echo. Diagnose the explicit refusal without rewriting the
  // shell's exit status. Polling a live shell (exitCode null) needs it too.
  if (!BIND_DENIED_SIGNATURES.some((pattern) => pattern.test(params.output))) {
    return null;
  }
  return {
    kind: "network_bind",
    notice: grant === "without_asking"
      ? SANDBOX_BIND_DENIED_WITHOUT_ASKING
      : grant === "with_approval"
        ? SANDBOX_BIND_DENIED_ESCALATION_AVAILABLE
        : SANDBOX_BIND_DENIED_NO_ESCALATION,
    advisesEscalation: grant !== "unavailable",
  };
}

/**
 * Signatures of "the OS refused this write": the sandbox's EPERM on macOS,
 * a read-only mount under bubblewrap.
 */
const WRITE_DENIED_SIGNATURES: readonly RegExp[] = [
  /operation not permitted/iu,
  /read-only file system/iu,
  /\bE(?:PERM|ROFS)\b/u,
];

/**
 * The notice for a worktree child's command that failed on a refused write,
 * or null. Its commands change files only inside the worktree and the temp
 * folder, escalated or not, so the retry the model would try next (with
 * sandbox_permissions) fails the same way. The text depends only on the
 * worktree, so the repeated-failure guard still sees one failure.
 */
export function worktreeWriteDenialNotice(params: {
  readonly output: string;
  readonly exitCode: number | null;
  readonly worktree: string;
}): string | null {
  if (params.exitCode === 0) return null;
  if (!WRITE_DENIED_SIGNATURES.some((pattern) => pattern.test(params.output))) {
    return null;
  }
  return (
    `[sandbox] This agent works in its own git worktree (${params.worktree}). ` +
    "Its commands change files only inside the worktree and in $TMPDIR: the OS " +
    "sandbox refuses every other write, with or without sandbox_permissions, so " +
    "escalating or retrying fails the same way. Work inside the worktree, and " +
    "point a tool that writes elsewhere (a package cache, for example) at $TMPDIR."
  );
}

/**
 * How a request to lift the sandbox is answered for this call. Under the
 * `never` policy nobody is asked: only the bypass sessions whose prompt says
 * the request is granted (prompts/permissions-prompt.ts) get it, without a
 * card. Elsewhere a person approves it, except where nobody can: a scheduled
 * routine never leaves its sandbox (tools/orchestrator.ts), a read-only
 * delegation child refuses the request outright
 * (agents/readonly-delegation.ts), and a print run (`agenc -p`) answers every
 * approval request with a deny (bin/daemon-one-shot-cli.ts). Pass the call's
 * sandbox mode and session so the notice and the prompt agree.
 */
export function sandboxEscalationGrant(
  approvalPolicy: string,
  call?: { readonly sandboxMode?: string; readonly session?: unknown },
): SandboxEscalationGrant {
  const session = call?.session;
  if (routineRunOptions(session) !== undefined) return "unavailable";
  if (readOnlyDelegationSession(session)) return "unavailable";
  if (approvalPolicy === "never") {
    return call?.sandboxMode === "workspace_write" && bypassGrantsSandboxEscalation(session)
      ? "without_asking"
      : "unavailable";
  }
  if (nonInteractiveSession(session)) return "unavailable";
  return "with_approval";
}

/** Whether asking to lift the sandbox can still produce an answer for this call. */
export function sandboxEscalationAvailable(
  approvalPolicy: string,
  call?: { readonly sandboxMode?: string; readonly session?: unknown },
): boolean {
  return sandboxEscalationGrant(approvalPolicy, call) !== "unavailable";
}

function readOnlyDelegationSession(session: unknown): boolean {
  return (session as { readonly services?: { readonly readOnlyDelegation?: unknown } } | null | undefined)
    ?.services?.readOnlyDelegation !== undefined;
}

function nonInteractiveSession(session: unknown): boolean {
  return (session as {
    readonly services?: { readonly runtimeOptions?: { readonly nonInteractive?: unknown } };
  } | null | undefined)?.services?.runtimeOptions?.nonInteractive === true;
}

/**
 * Whether a bypassPermissions session is told that leaving the sandbox is
 * granted without asking. It reads the mode the way the orchestrator does
 * (tools/orchestrator.ts), which grants the request in that mode, and leaves
 * out the sessions where the grant would not help or the prompt says
 * otherwise: a scheduled routine never leaves its sandbox; a worktree or
 * read-only delegation child stays confined (escalationStaysConfined); a
 * Light print run's prompt tells the model not to escalate.
 */
export function bypassGrantsSandboxEscalation(session: unknown): boolean {
  if (routineRunOptions(session) !== undefined) return false;
  if (escalationStaysConfined(session)) return false;
  const record = session as {
    readonly permissionModeRegistry?: { readonly current?: () => unknown };
    readonly services?: {
      readonly runtimeOptions?: Parameters<typeof isLightPrintRun>[0];
      readonly providerEnvironment?: Parameters<typeof isLightPrintRun>[1];
    };
  } | null | undefined;
  if (isLightPrintRun(record?.services?.runtimeOptions, record?.services?.providerEnvironment)) {
    return false;
  }
  return asRecord(record?.permissionModeRegistry?.current?.())?.mode === "bypassPermissions";
}
