import { basename } from "node:path";

import { peekAmbientRuntimeSession } from "../session/current-session.js";
import {
  missingSandboxExecutionBoundary,
  type SandboxExecutionBrokerLike,
} from "../sandbox/execution-broker.js";
import type { ToolUseContext } from "./Tool.js";
import { gitChildEnvironment } from "../sandbox/git-environment.js";
import { hardenGitWorktreeMutationArgs } from "../sandbox/worktree-permissions.js";
import { transitionSandboxExecutionBroker } from "../sandbox/execution-lifecycle.js";
import { runSupervisedProcess } from "../utils/supervisedProcess.js";

const WORKTREE_GIT_TIMEOUT_MS = 5_000;
const WORKTREE_GIT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export function requireWorktreeSandboxBrokers(
  context: ToolUseContext,
): readonly SandboxExecutionBrokerLike[] {
  const extended = context as ToolUseContext & {
    readonly services?: {
      readonly sandboxExecutionBroker?: SandboxExecutionBrokerLike;
    };
    readonly session?: {
      readonly services?: {
        readonly sandboxExecutionBroker?: SandboxExecutionBrokerLike;
      };
    };
  };
  const brokers = new Set<SandboxExecutionBrokerLike>();
  const ambient = peekAmbientRuntimeSession()?.services.sandboxExecutionBroker;
  for (const broker of [
    extended.services?.sandboxExecutionBroker,
    extended.session?.services?.sandboxExecutionBroker,
    ambient,
  ]) {
    if (broker !== undefined) brokers.add(broker);
  }
  if (brokers.size === 0) {
    throw missingSandboxExecutionBoundary("tool");
  }
  return [...brokers];
}

export async function rebaseWorktreeSandboxBrokers(
  brokers: readonly SandboxExecutionBrokerLike[],
  cwd: string,
): Promise<void> {
  const uniqueBrokers = [...new Set(brokers)];
  const transitioned: Array<{
    readonly broker: SandboxExecutionBrokerLike;
    readonly previousCwd: string;
  }> = [];
  try {
    for (const broker of uniqueBrokers) {
      if (broker.cwd === cwd) continue;
      const previousCwd = broker.cwd;
      await transitionSandboxExecutionBroker(broker, cwd);
      transitioned.push({ broker, previousCwd });
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const entry of [...transitioned].reverse()) {
      try {
        await transitionSandboxExecutionBroker(
          entry.broker,
          entry.previousCwd,
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "sandbox worktree rebase failed and rollback was incomplete",
      );
    }
    throw error;
  }
}

export function runWorktreeSandboxedProcess(
  sandboxExecutionBroker: SandboxExecutionBrokerLike,
  program: string,
  args: readonly string[],
  cwd: string,
) {
  const executableName = basename(program).toLowerCase();
  if (!["git", "git.exe", "git.cmd"].includes(executableName)) {
    throw new Error("worktree inspection only permits the Git executable");
  }
  const command = sandboxExecutionBroker.prepareSpawn("tool", {
    program,
    args: hardenGitWorktreeMutationArgs(["--no-optional-locks", ...args]),
    cwd,
    env: gitChildEnvironment(process.env),
    argv0: basename(program),
    trustedExecutable: true,
  });
  return runSupervisedProcess(command, {
    timeoutMs: WORKTREE_GIT_TIMEOUT_MS,
    maxOutputBytes: WORKTREE_GIT_MAX_OUTPUT_BYTES,
  }).then((result) => {
    const stopped = result.stopReason !== undefined;
    const code = result.exitCode === 0 && !stopped
      ? 0
      : (result.exitCode ?? 1);
    const error = result.error?.message ??
      (result.stopReason !== undefined
        ? `Git process stopped: ${result.stopReason}`
        : result.signal !== null
          ? `Git process terminated by ${result.signal}`
          : undefined);
    return {
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
      code,
      ...(error !== undefined ? { error } : {}),
    };
  });
}
