import { basename } from "node:path";

import { peekAmbientRuntimeSession } from "../session/current-session.js";
import {
  missingSandboxExecutionBoundary,
  type SandboxExecutionBrokerLike,
} from "../sandbox/execution-broker.js";
import type { ToolUseContext } from "./Tool.js";
import { execFileNoThrowWithCwd } from "../utils/execFileNoThrow.js";

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

export function rebaseWorktreeSandboxBrokers(
  brokers: readonly SandboxExecutionBrokerLike[],
  cwd: string,
): void {
  for (const broker of brokers) broker.rebase(cwd);
}

export function runWorktreeSandboxedProcess(
  sandboxExecutionBroker: SandboxExecutionBrokerLike,
  program: string,
  args: readonly string[],
  cwd: string,
) {
  const command = sandboxExecutionBroker.prepareSpawn("tool", {
    program,
    args,
    cwd,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    argv0: basename(program),
  });
  return execFileNoThrowWithCwd(command.program, [...command.args], {
    cwd: command.cwd,
    env: command.env,
    argv0: command.argv0,
  });
}
