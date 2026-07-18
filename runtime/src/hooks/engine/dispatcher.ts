/**
 * Hook dispatcher.
 *
 * Dispatches AgenC command hooks by selecting matching handlers once, running
 * subprocesses, and recording sanitized diagnostics while preserving raw
 * stdout/stderr for parser callers.
 */

import { randomUUID } from "node:crypto";

import type { HookEventName, HooksMap } from "../../config/schema.js";
import { hookEventIgnoresConfiguredMatcher } from "../../permissions/hook-event-schedule.js";
import { redactSecrets } from "../../secrets/index.js";
import { runHookCommand } from "./command-runner.js";
import { flattenHooks } from "./discovery.js";
import { AdmissionDeniedError } from "../../budget/admission-client.js";
import type {
  CommandRunResult,
  HookCommandRunDiagnostic,
  HookDispatchResult,
  HookEngineOptions,
  HookRunDiagnostic,
  IndividualHookConfig,
} from "./types.js";

export const DEFAULT_HOOK_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_DIAGNOSTICS = 50;

export class HookEngine {
  private config: HooksMap | undefined;
  private disabled = false;
  private diagnostics: HookRunDiagnostic[] = [];

  constructor(private readonly opts: HookEngineOptions) {}

  load(config: HooksMap | undefined): void {
    this.config = config;
  }

  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
  }

  isDisabled(): boolean {
    return this.disabled;
  }

  listHooks(): readonly IndividualHookConfig[] {
    return flattenHooks(this.config, this.opts.sourcePath);
  }

  latestDiagnostics(): readonly HookRunDiagnostic[] {
    return this.diagnostics;
  }

  clearDiagnostics(): void {
    this.diagnostics = [];
  }

  selectHandlers(
    event: HookEventName,
    matcherInput?: string,
  ): readonly IndividualHookConfig[] {
    const inputs = matcherInput === undefined ? [] : [matcherInput];
    return this.selectHandlersForMatcherInputs(event, inputs);
  }

  selectHandlersForMatcherInputs(
    event: HookEventName,
    matcherInputs: readonly string[],
  ): readonly IndividualHookConfig[] {
    return this.listHooks()
      .filter((hook) => hook.enabled)
      .filter((hook) => hook.event === event)
      .filter((hook) => {
        if (hookEventIgnoresConfiguredMatcher(event)) {
          return true;
        }
        if (matcherInputs.length === 0) {
          return matchesPattern("", hook.matcher);
        }
        return matcherInputs.some((input) =>
          matchesPattern(input, hook.matcher),
        );
      });
  }

  async dispatch(
    event: HookEventName,
    matcherInputs: readonly string[],
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<readonly HookDispatchResult[]> {
    const handlers = this.selectHandlersForMatcherInputs(event, matcherInputs);
    return Promise.all(
      handlers.map(async (hook) => ({
        hook,
        run: await this.runCommandHook(hook, input, signal, inputCwd(input)),
      })),
    );
  }

  async runCommandHook(
    hook: IndividualHookConfig,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    cwd?: string,
  ): Promise<HookCommandRunDiagnostic> {
    const startedAtUnixMs = Date.now();
    if (this.disabled) {
      return this.recordDiagnostic(
        hook,
        {
          status: "skipped",
          stdout: "",
          stderr: "",
          durationMs: 0,
        },
        startedAtUnixMs,
      );
    }
    const invoke = (effectSignal: AbortSignal | undefined) =>
      runHookCommand({
        command: hook.command.command,
        cwd: cwd ?? this.opts.cwd,
        env: this.opts.env,
        shellPath: this.opts.shellPath,
        stdin: `${JSON.stringify(input)}\n`,
        timeoutMs: hook.command.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS,
        signal: effectSignal,
        ...(this.opts.sandboxExecutionBroker !== undefined
          ? { sandboxExecutionBroker: this.opts.sandboxExecutionBroker }
          : {}),
      });
    const admission = this.opts.executionAdmission;
    if (admission === undefined && this.opts.admissionRequired !== false) {
      throw new AdmissionDeniedError("hook_admission_unavailable");
    }
    let result: CommandRunResult;
    if (admission === undefined) {
      result = await invoke(signal);
    } else {
      const lease = await admission.acquire(
        {
          stepId: `hook:${hook.event}:${randomUUID()}`,
          kind: "tool_exec",
          sessionId: admission.scope.sessionId,
          parentScopeId: `hook:${hook.event}`,
          maxInputTokens: 0,
          maxOutputTokens: 0,
          // This admission accounts for the local subprocess effect itself.
          // Any paid provider invoked by that process must perform its own
          // admitted request; never classify this local boundary as unpriced
          // and then reconcile it as free.
          maxCostUsd: 0,
        },
        signal,
      );
      const reservationId = lease.reservation.reservationId;
      let dispatched = false;
      try {
        admission.markDispatched(reservationId, {
          boundary: "tool_effect",
          details: { hookEvent: hook.event, hookIndex: hook.index },
        });
        dispatched = true;
        result = await invoke(lease.signal);
        if (lease.signal.aborted) {
          admission.holdUnknown(reservationId, "hook_cancelled_after_dispatch");
        } else {
          admission.reconcile(reservationId, {
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
          });
        }
      } catch (error) {
        if (dispatched) {
          admission.holdUnknown(reservationId, "hook_failed_after_dispatch");
        } else {
          admission.void(reservationId, "hook_failed_before_dispatch");
        }
        throw error;
      } finally {
        // Settlement/journal faults must not retain the daemon's live slot
        // after the hook subprocess has physically stopped (or failed before
        // spawn). Durable recovery can classify the reservation separately.
        admission.acknowledgeCompletion(reservationId);
      }
    }
    return this.recordDiagnostic(hook, result, startedAtUnixMs);
  }

  recordHookOutputIssue(run: HookCommandRunDiagnostic, message: string): void {
    this.diagnostics = this.diagnostics.map((diagnostic) => {
      if (diagnostic.id !== run.id) return diagnostic;
      const existing = diagnostic.error;
      return {
        ...diagnostic,
        error:
          existing !== undefined && existing.length > 0
            ? `${existing}; ${message}`
            : message,
      };
    });
  }

  private recordDiagnostic(
    hook: IndividualHookConfig,
    result: CommandRunResult,
    startedAtUnixMs: number,
  ): HookCommandRunDiagnostic {
    const sanitizedResult = sanitizeCommandRunResult(result);
    const diagnostic: HookRunDiagnostic = {
      id: randomUUID(),
      event: hook.event,
      ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
      command: redactSecrets(hook.command.command),
      status: sanitizedResult.status,
      ...(sanitizedResult.exitCode !== undefined
        ? { exitCode: sanitizedResult.exitCode }
        : {}),
      durationMs: sanitizedResult.durationMs,
      stdout: sanitizedResult.stdout,
      stderr: sanitizedResult.stderr,
      ...(sanitizedResult.error !== undefined
        ? { error: sanitizedResult.error }
        : {}),
      startedAtUnixMs,
    };
    this.diagnostics = [diagnostic, ...this.diagnostics].slice(
      0,
      this.opts.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS,
    );
    return {
      ...diagnostic,
      rawStdout: result.stdout,
      rawStderr: result.stderr,
      ...(result.error !== undefined ? { rawError: result.error } : {}),
    };
  }
}

function inputCwd(input: Record<string, unknown>): string | undefined {
  const cwd = input.cwd;
  return typeof cwd === "string" && cwd.trim().length > 0 ? cwd : undefined;
}

export function matchesPattern(matchQuery: string, matcher?: string): boolean {
  if (matcher === undefined || matcher.trim() === "" || matcher === "*") {
    return true;
  }
  if (isUnsafeMatcherRegex(matcher)) {
    return false;
  }
  if (/^[a-zA-Z0-9_.|-]+$/.test(matcher)) {
    if (matcher.includes("|")) {
      return matcher
        .split("|")
        .map((p) => p.trim())
        .includes(matchQuery);
    }
    return matchQuery === matcher;
  }
  try {
    return new RegExp(matcher).test(matchQuery);
  } catch {
    return false;
  }
}

function isUnsafeMatcherRegex(matcher: string): boolean {
  if (matcher.length > 512) return true;
  return /\((?:[^()\\]|\\.|\([^)]*\))*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(
    matcher,
  );
}

function sanitizeCommandRunResult(result: CommandRunResult): CommandRunResult {
  return {
    ...result,
    stdout: redactSecrets(result.stdout),
    stderr: redactSecrets(result.stderr),
    ...(result.error !== undefined
      ? { error: redactSecrets(result.error) }
      : {}),
  };
}
