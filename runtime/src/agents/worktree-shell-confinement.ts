/**
 * A subagent isolated in a git worktree runs shell commands that change
 * files inside that worktree only.
 *
 * The OS sandbox is the boundary: a worktree child's command sandbox writes
 * only inside the worktree and its temp folder (see
 * sandbox/worktree-confinement.ts), whatever an escalation asks for. This
 * check comes first and also covers a session that runs without a sandbox.
 * Before a worktree child's shell command runs, the paths its command line
 * writes, removes or moves are read, each in the directory it runs in (a
 * `cd` in the line included), and the call is refused when one of them is
 * outside the worktree and the temp folders. The refusal reaches the model
 * as a tool error it recovers from by working inside its worktree; it is not
 * a permission denial, which would end a whole Goal run as policy_denied.
 * What a program writes on its own (`node -e`, `git -C ..`) is not visible
 * on the command line; only the sandbox stops that.
 */

import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { collectShellMutationTargets } from "../llm/shell-write-policy.js";
import {
  canonicalAuthorityPath,
  isWithinAuthorityPath,
} from "../sandbox/desktop-authority-protection.js";
import type { WorktreeWriteConfinement } from "../sandbox/worktree-confinement.js";

/** The shell tools: the argument holding the command, its argument vector, and its directory. */
const SHELL_TOOL_ARGUMENTS: Readonly<Record<string, {
  readonly command: string;
  readonly argv?: string;
  readonly cwd?: string;
}>> = {
  exec_command: { command: "cmd", cwd: "workdir" },
  "system.bash": { command: "command", argv: "args", cwd: "cwd" },
  // Input typed into a running shell: its directory is not known here.
  write_stdin: { command: "chars" },
};

/** Temp folders a command may use besides the one the session gives it as TMPDIR. */
const SYSTEM_TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];

function canonical(target: string): string {
  try {
    return canonicalAuthorityPath(target);
  } catch {
    return target;
  }
}

/** Device files (`/dev/tty`) are not files of any checkout. */
function isDevicePath(target: string): boolean {
  return target === "/dev" || target.startsWith("/dev/");
}

function staysInsideConfinement(
  target: string,
  confinement: WorktreeWriteConfinement,
  tempRoots: readonly string[],
): boolean {
  if (isDevicePath(target)) return true;
  const resolved = canonical(target);
  if (isWithinAuthorityPath(resolved, canonical(confinement.worktree))) return true;
  const checkout = canonical(confinement.checkout);
  return tempRoots.some((root) => {
    const temp = canonical(root);
    if (!isWithinAuthorityPath(resolved, temp)) return false;
    // A temp folder inside the checkout (a routine run's scratch folder) is
    // still scratch space; a checkout inside a temp folder is not.
    return isWithinAuthorityPath(temp, checkout) ||
      !isWithinAuthorityPath(resolved, checkout);
  });
}

/**
 * The refusal for a worktree child's shell command that would change a
 * file outside its worktree, or undefined when the command stays inside
 * (or is not a shell command). `tempRoot` is the folder the session gives
 * commands as TMPDIR.
 */
export function worktreeShellWriteRefusal(
  toolName: string,
  input: unknown,
  confinement: WorktreeWriteConfinement | undefined,
  tempRoot: string | undefined,
): string | undefined {
  if (confinement === undefined) return undefined;
  const fields = SHELL_TOOL_ARGUMENTS[toolName];
  if (fields === undefined) return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const args = input as Record<string, unknown>;
  const command = args[fields.command];
  if (typeof command !== "string" || command.trim().length === 0) return undefined;
  const rawCwd = fields.cwd === undefined ? undefined : args[fields.cwd];
  const cwd = typeof rawCwd === "string" && rawCwd.trim().length > 0
    ? resolve(confinement.worktree, rawCwd.trim())
    : confinement.worktree;
  const argv = fields.argv === undefined ? undefined : args[fields.argv];
  const { targets } = collectShellMutationTargets({
    toolName,
    args: { command, cwd, ...(Array.isArray(argv) ? { args: argv } : {}) },
    workspaceRoot: confinement.worktree,
  });
  const tempRoots = [...(tempRoot !== undefined ? [tempRoot] : []), tmpdir(), ...SYSTEM_TEMP_ROOTS];
  const outside = targets.filter(
    (target) => !staysInsideConfinement(target, confinement, tempRoots),
  );
  if (outside.length === 0) return undefined;
  return `This agent works in its own git worktree (${confinement.worktree}); ` +
    `this command would change ${outside.join(", ")}, outside it, and was not run. ` +
    "Work inside the worktree and put scratch files in $TMPDIR: the files outside it " +
    "belong to the checkout the worktree isolates, or to the rest of the machine, and must not change.";
}
