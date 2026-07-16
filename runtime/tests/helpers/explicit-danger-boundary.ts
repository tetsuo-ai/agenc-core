import {
  SandboxExecutionBroker,
  attachSandboxExecutionBroker,
} from "../../src/sandbox/execution-broker.js";

export const explicitDangerBroker = new SandboxExecutionBroker({
  mode: "danger_full_access",
  cwd: process.cwd(),
});

/**
 * Unit tests that intentionally exercise host process mechanics must declare
 * that intent explicitly, just like an operator selecting --yolo.
 */
export function bindExplicitDangerBoundary<
  T extends {
    readonly execute: (
      args: Record<string, unknown>,
    ) => Promise<unknown>;
  },
>(tool: T): T {
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(args: Record<string, unknown>): Promise<unknown> {
      attachSandboxExecutionBroker(args, explicitDangerBroker);
      return execute(args);
    },
  } as T;
}

export function withExplicitDangerBoundary(
  args: Record<string, unknown>,
): Record<string, unknown> {
  attachSandboxExecutionBroker(args, explicitDangerBroker);
  return args;
}
