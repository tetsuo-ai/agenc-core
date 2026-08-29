/**
 * Adds post-tool feedback after canonical file mutations, with turn-scoped
 * retry accounting and contained check failures.
 */

import type { PostToolUseHook } from "../../tools/hooks.js";
import {
  FILE_EDIT_TOOL_NAME,
  FILE_MULTI_EDIT_TOOL_NAME,
} from "../../tools/system/file-edit.js";
import { FILE_WRITE_TOOL_NAME } from "../../tools/system/file-write.js";
import {
  getAutoFixConfig,
  type AutoFixConfig,
} from "./autoFixConfig.js";
import {
  runAutoFixCheck,
  type AutoFixCheckOptions,
  type AutoFixResult,
} from "./autoFixRunner.js";
import type { SandboxExecutionBrokerLike } from "../../sandbox/execution-broker.js";
import type { HookExecutionAuthority } from "../../hooks/execution-authority.js";

const AUTO_FIX_TOOLS = new Set([
  FILE_EDIT_TOOL_NAME,
  FILE_MULTI_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
]);

export interface AutoFixPostToolHookOptions {
  readonly configSource: () => unknown;
  readonly cwd: string;
  readonly executionAuthority: HookExecutionAuthority;
  readonly sandboxExecutionBroker?: SandboxExecutionBrokerLike;
  readonly env?: NodeJS.ProcessEnv;
  readonly shellPath?: string;
  readonly commandWrapperArgv?: readonly string[];
  readonly retryScope?: (input: Parameters<PostToolUseHook>[0]) => string;
  readonly runCheck?: (options: AutoFixCheckOptions) => Promise<AutoFixResult>;
  readonly onError?: (error: unknown) => void;
}

export function shouldRunAutoFix(
  toolName: string,
  config: AutoFixConfig | null,
): boolean {
  if (!config) return false;
  return AUTO_FIX_TOOLS.has(toolName);
}

export function buildAutoFixContext(result: AutoFixResult): string | null {
  if (!result.hasErrors || !result.errorSummary) return null;

  return (
    `<auto_fix_feedback>\n` +
    `AUTO-FIX: The file you just edited has errors. Please fix them:\n\n` +
    `${result.errorSummary}\n\n` +
    `Please fix these errors in the files you just edited. ` +
    `Do not ask the user; apply the fix.\n` +
    `</auto_fix_feedback>`
  );
}

function defaultRetryScope(input: Parameters<PostToolUseHook>[0]): string {
  const turn = input.invocation.turn as
    | {
        readonly subId?: unknown;
        readonly turnId?: unknown;
        readonly id?: unknown;
      }
    | undefined;
  const value = turn?.subId ?? turn?.turnId ?? turn?.id;
  return typeof value === "string" && value.length > 0 ? value : "default";
}

function retryLimitContext(maxRetries: number): string {
  return (
    `<auto_fix_feedback>\n` +
    `AUTO-FIX: Maximum retry limit (${maxRetries}) reached. ` +
    `Skipping further auto-fix attempts. Please review the errors manually.\n` +
    `</auto_fix_feedback>`
  );
}

export function createAutoFixPostToolHook(
  options: AutoFixPostToolHookOptions,
): PostToolUseHook {
  const retryCount = new Map<string, number>();
  const runCheck = options.runCheck ?? runAutoFixCheck;
  const retryScope = options.retryScope ?? defaultRetryScope;

  return async (input) => {
    if (!options.executionAuthority.decision("command").allowed) {
      return { kind: "continue" };
    }
    const config = getAutoFixConfig(options.configSource());
    if (!shouldRunAutoFix(input.tool.name, config) || !config) {
      return { kind: "continue" };
    }

    const scope = retryScope(input);
    const currentRetries = retryCount.get(scope) ?? 0;
    if (currentRetries >= config.maxRetries) {
      return {
        kind: "additionalContext",
        content: [retryLimitContext(config.maxRetries)],
      };
    }

    try {
      const result = await runCheck({
        lint: config.lint,
        test: config.test,
        timeout: config.timeout,
        cwd: options.cwd,
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.shellPath !== undefined
          ? { shellPath: options.shellPath }
          : {}),
        ...(options.commandWrapperArgv !== undefined
          ? { commandWrapperArgv: options.commandWrapperArgv }
          : {}),
        signal: input.signal,
        sandboxExecutionBroker: options.sandboxExecutionBroker,
      });
      const context = buildAutoFixContext(result);
      if (context) {
        retryCount.set(scope, currentRetries + 1);
        return { kind: "additionalContext", content: [context] };
      }
      retryCount.delete(scope);
    } catch (error) {
      options.onError?.(error);
    }

    return { kind: "continue" };
  };
}
