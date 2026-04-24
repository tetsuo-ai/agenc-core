import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import type { BashToolConfig } from "./types.js";
import { createBashTool } from "./bash.js";
import {
  createApplyPatchTool,
  type ApplyPatchRunner,
} from "./apply-patch.js";

export interface ExecCommandToolConfig extends BashToolConfig {
  readonly allowedPaths?: readonly string[];
  readonly applyPatchRunner?: ApplyPatchRunner;
}

const APPLY_PATCH_HEREDOC_RE =
  /^\s*apply_patch\s+<<\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*\n([\s\S]*?)\n\1\s*$/u;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function extractApplyPatchHeredoc(command: string): string | undefined {
  const match = APPLY_PATCH_HEREDOC_RE.exec(command);
  return match?.[2];
}

export function createExecCommandTool(config?: ExecCommandToolConfig): Tool {
  const bash = createBashTool(config);
  const applyPatch = createApplyPatchTool({
    allowedPaths: config?.allowedPaths ?? [config?.cwd ?? process.cwd()],
    ...(config?.applyPatchRunner !== undefined
      ? { runner: config.applyPatchRunner }
      : {}),
  });
  return {
    name: "exec_command",
    description:
      "Run a shell command in the current AgenC workspace and return captured stdout/stderr. Use this for inspection, tests, builds, and other terminal work. Use apply_patch, not shell redirection, for source-file edits.",
    metadata: {
      family: "terminal",
      source: "builtin",
      keywords: ["exec", "command", "shell", "terminal", "bash", "agenc"],
      preferredProfiles: ["coding", "validation", "operator"],
      hiddenByDefault: false,
      mutating: true,
      deferred: false,
    },
    requiresApproval: true,
    concurrencyClass: bash.concurrencyClass,
    isReadOnly: false,
    supportsParallelToolCalls: false,
    isConcurrencySafe: bash.isConcurrencySafe,
    interruptBehavior: bash.interruptBehavior,
    inputSchema: {
      type: "object",
      properties: {
        cmd: {
          type: "string",
          description: "Shell command to execute.",
        },
        command: {
          type: "string",
          description:
            "Compatibility alias for cmd. Prefer cmd for Codex-style calls.",
        },
        workdir: {
          type: "string",
          description: "Working directory. Defaults to the AgenC workspace root.",
        },
        cwd: {
          type: "string",
          description:
            "Compatibility alias for workdir. Prefer workdir for Codex-style calls.",
        },
        timeoutMs: {
          type: "number",
          description: "Optional command timeout in milliseconds.",
        },
        yield_time_ms: {
          type: "number",
          description:
            "Compatibility field accepted from Codex-style callers. AgenC currently runs the command to completion and ignores this value.",
        },
        max_output_tokens: {
          type: "number",
          description:
            "Compatibility field accepted from Codex-style callers. AgenC output is capped by runtime byte limits.",
        },
        login: {
          type: "boolean",
          description:
            "Compatibility field accepted from Codex-style callers. AgenC executes through its configured shell runtime.",
        },
        tty: {
          type: "boolean",
          description:
            "Compatibility field accepted from Codex-style callers. AgenC captures stdout/stderr without allocating an interactive TTY.",
        },
        shell: {
          type: "string",
          description:
            "Compatibility field accepted from Codex-style callers. AgenC uses its configured bash-compatible shell runtime.",
        },
      },
      anyOf: [{ required: ["cmd"] }, { required: ["command"] }],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as Record<string, unknown> & ToolExecutionInjectedArgs;
      const cmd = asString(args.cmd) ?? asString(args.command);
      if (!cmd) {
        return {
          content: safeStringify({ error: "cmd must be a non-empty string" }),
          isError: true,
        };
      }
      const workdir = asString(args.workdir) ?? asString(args.cwd);
      const timeoutMs = asNumber(args.timeoutMs);
      const applyPatchBody = extractApplyPatchHeredoc(cmd);
      if (applyPatchBody !== undefined) {
        return applyPatch.execute({
          patch: applyPatchBody,
          ...(workdir !== undefined ? { cwd: workdir } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(args.__abortSignal !== undefined
            ? { __abortSignal: args.__abortSignal }
            : {}),
        });
      }

      return bash.execute({
        command: cmd,
        ...(workdir !== undefined ? { cwd: workdir } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(args.__abortSignal !== undefined
          ? { __abortSignal: args.__abortSignal }
          : {}),
        ...(args.__onProgress !== undefined
          ? { __onProgress: args.__onProgress }
          : {}),
      });
    },
  };
}
