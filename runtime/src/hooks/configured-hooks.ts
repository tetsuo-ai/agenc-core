import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";

import type {
  HookCommand,
  HookEventName,
  HooksMap,
} from "../config/schema.js";
import {
  HOOK_EVENT_NAMES,
  InvalidHooksConfigError,
  validateHooksConfig,
} from "../config/schema.js";
import type {
  HookPermissionBehavior,
  PermissionDecisionHook,
  PermissionDecisionResult,
  PostToolUseFailureHook,
  PostToolUseHook,
  PreToolUseHook,
} from "../tools/hooks.js";
import type {
  StopHookHandler,
  StopHookOutcome,
  StopRequest,
} from "../phases/stop-hooks.js";
import type { UserPromptSubmitHook } from "./user-prompt-submit.js";
import type {
  HookResult,
  PostCompactHookInput,
  PreCompactHookInput,
  SessionStartHookInput,
} from "../llm/hooks/types.js";
import { redactSecrets } from "../secrets/index.js";

const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const MAX_DIAGNOSTICS = 50;

export type HookRunStatus =
  | "success"
  | "blocking"
  | "non_blocking_error"
  | "timeout"
  | "skipped";

export interface HookRunDiagnostic {
  readonly id: string;
  readonly event: HookEventName;
  readonly matcher?: string;
  readonly command: string;
  readonly status: HookRunStatus;
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
  readonly startedAtUnixMs: number;
}

export interface IndividualHookConfig {
  readonly event: HookEventName;
  readonly matcher?: string;
  readonly command: HookCommand;
  readonly source: "config";
  readonly sourcePath: string;
  readonly enabled: boolean;
  readonly index: number;
}

export interface HookValidationIssue {
  readonly level: "error" | "warning";
  readonly message: string;
}

export interface HookInstallTarget {
  readonly preToolUseHooks: PreToolUseHook[];
  readonly postToolUseHooks: PostToolUseHook[];
  readonly failureToolUseHooks: PostToolUseFailureHook[];
  readonly permissionDecisionHooks: PermissionDecisionHook[];
  readonly userPromptSubmitHooks: UserPromptSubmitHook[];
  readonly stopHooks: StopHookHandler[];
  readonly stopFailureHooks: StopHookHandler[];
  readonly addPreCompactHook?: (
    hook: (
      input: PreCompactHookInput,
      signal?: AbortSignal,
    ) => Promise<HookResult>,
  ) => void;
  readonly addPostCompactHook?: (
    hook: (
      input: PostCompactHookInput,
      signal?: AbortSignal,
    ) => Promise<HookResult>,
  ) => void;
  readonly addSessionStartHook?: (
    hook: (
      input: SessionStartHookInput,
      signal?: AbortSignal,
    ) => Promise<HookResult>,
  ) => void;
  readonly clearConfiguredLifecycleHooks?: () => void;
}

export interface ConfiguredHooksRuntimeOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly agencHome: string;
  readonly shellPath: string;
}

interface CommandRunResult {
  readonly status: HookRunStatus;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly error?: string;
}

interface HookCommandRunDiagnostic extends HookRunDiagnostic {
  readonly rawStdout: string;
  readonly rawStderr: string;
  readonly rawError?: string;
}

type HookSpecificOutput = {
  readonly hookEventName?: string;
  readonly permissionDecision?: HookPermissionBehavior;
  readonly permissionDecisionReason?: string;
  readonly updatedInput?: Record<string, unknown>;
  readonly additionalContext?: string;
  readonly decision?: {
    readonly behavior?: string;
    readonly updatedInput?: Record<string, unknown>;
    readonly message?: string;
  };
};

interface ParsedHookSpecificOutput {
  readonly explicit: boolean;
  readonly output?: HookSpecificOutput;
  readonly invalid?: string;
}

export class ConfiguredHooksRuntime {
  private config: HooksMap | undefined;
  private validationIssues: HookValidationIssue[] = [];
  private disabled = false;
  private diagnostics: HookRunDiagnostic[] = [];
  private target: HookInstallTarget | null = null;

  constructor(private readonly opts: ConfiguredHooksRuntimeOptions) {}

  attachTarget(target: HookInstallTarget): void {
    this.target = target;
    this.rebuildTarget();
  }

  load(raw: HooksMap | undefined): void {
    try {
      this.config = validateHooksConfig(raw);
      this.validationIssues = [];
    } catch (err) {
      this.config = undefined;
      this.validationIssues = [
        {
          level: "error",
          message:
            err instanceof InvalidHooksConfigError
              ? err.message
              : `Invalid hooks config: ${String(err)}`,
        },
      ];
    }
    this.rebuildTarget();
  }

  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
  }

  isDisabled(): boolean {
    return this.disabled;
  }

  listHooks(): readonly IndividualHookConfig[] {
    return flattenHooks(this.config, this.sourcePath());
  }

  issues(): readonly HookValidationIssue[] {
    return this.validationIssues;
  }

  latestDiagnostics(): readonly HookRunDiagnostic[] {
    return this.diagnostics;
  }

  clearDiagnostics(): void {
    this.diagnostics = [];
  }

  sourcePath(): string {
    return join(this.opts.agencHome, "config.toml");
  }

  async testHook(
    hook: IndividualHookConfig,
    input: Record<string, unknown> = defaultHookInput(hook.event, this.opts.cwd),
  ): Promise<HookRunDiagnostic> {
    const result = await this.runCommandHook(hook, input);
    return this.diagnostics.find((d) => d.id === result.id) ?? result;
  }

  private rebuildTarget(): void {
    const target = this.target;
    if (!target) return;
    target.preToolUseHooks.length = 0;
    target.postToolUseHooks.length = 0;
    target.failureToolUseHooks.length = 0;
    target.permissionDecisionHooks.length = 0;
    target.userPromptSubmitHooks.length = 0;
    target.stopHooks.length = 0;
    target.stopFailureHooks.length = 0;
    target.clearConfiguredLifecycleHooks?.();

    for (const hook of this.listHooks()) {
      if (!hook.enabled) continue;
      switch (hook.event) {
        case "PreToolUse":
          target.preToolUseHooks.push(this.createPreToolUseHook(hook));
          break;
        case "PostToolUse":
          target.postToolUseHooks.push(this.createPostToolUseHook(hook));
          break;
        case "PostToolUseFailure":
          target.failureToolUseHooks.push(this.createFailureHook(hook));
          break;
        case "PermissionRequest":
          target.permissionDecisionHooks.push(this.createPermissionHook(hook));
          break;
        case "UserPromptSubmit":
          target.userPromptSubmitHooks.push(this.createUserPromptSubmitHook(hook));
          break;
        case "Stop":
          target.stopHooks.push(this.createStopHook(hook));
          break;
        case "StopFailure":
          target.stopFailureHooks.push(this.createStopFailureHook(hook));
          break;
        case "PreCompact":
          target.addPreCompactHook?.(this.createLifecycleHook(hook));
          break;
        case "PostCompact":
          target.addPostCompactHook?.(this.createLifecycleHook(hook));
          break;
        case "SessionStart":
          target.addSessionStartHook?.(this.createLifecycleHook(hook));
          break;
      }
    }
  }

  private createPreToolUseHook(hook: IndividualHookConfig): PreToolUseHook {
    return async ({ invocation, tool, args }) => {
      const toolName = tool.name;
      if (this.disabled || !matchesPattern(toolName, hook.matcher)) {
        return { kind: "continue" };
      }
      const result = await this.runCommandHook(hook, {
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: args,
        tool_use_id: invocation.callId,
      });
      if (result.status === "blocking") {
        return { kind: "deny", reason: result.stderr || result.stdout };
      }
      if (result.status !== "success") return { kind: "continue" };
      const parsed = readHookSpecificOutput(result.rawStdout);
      if (parsed.invalid) this.recordHookOutputIssue(result, parsed.invalid);
      const specific = parsed.output;
      const decision = specific?.permissionDecision;
      const updatedInput = specific?.updatedInput;
      return {
        kind: "continue",
        ...(updatedInput !== undefined ? { args: updatedInput } : {}),
        ...(decision !== undefined
          ? {
              hookPermissionResult: {
                behavior: decision,
                ...(specific?.permissionDecisionReason !== undefined
                  ? { message: redactSecrets(specific.permissionDecisionReason) }
                  : {}),
                ...(updatedInput !== undefined ? { updatedInput } : {}),
              },
            }
          : {}),
        ...(specific?.additionalContext !== undefined
          ? { additionalContext: [redactSecrets(specific.additionalContext)] }
          : {}),
      };
    };
  }

  private createPostToolUseHook(hook: IndividualHookConfig): PostToolUseHook {
    return async ({ invocation, tool, args, result }) => {
      const toolName = tool.name;
      if (this.disabled || !matchesPattern(toolName, hook.matcher)) {
        return { kind: "continue" };
      }
      const run = await this.runCommandHook(hook, {
        hook_event_name: "PostToolUse",
        tool_name: toolName,
        tool_input: args,
        tool_use_id: invocation.callId,
        tool_response: result,
        inputs: args,
        response: result,
      });
      if (run.status === "blocking") {
        return {
          kind: "hook_blocking_error",
          blockingError: run.stderr || run.stdout,
        };
      }
      if (run.status !== "success") return { kind: "continue" };
      const specific = parseHookSpecificOutput(run.rawStdout);
      if (specific?.additionalContext) {
        return {
          kind: "additionalContext",
          content: [redactSecrets(specific.additionalContext)],
        };
      }
      return { kind: "continue" };
    };
  }

  private createFailureHook(hook: IndividualHookConfig): PostToolUseFailureHook {
    return async ({ invocation, tool, args, error, isInterrupt }) => {
      const toolName = tool.name;
      if (this.disabled || !matchesPattern(toolName, hook.matcher)) return;
      await this.runCommandHook(hook, {
        hook_event_name: "PostToolUseFailure",
        tool_name: toolName,
        tool_input: args,
        tool_use_id: invocation.callId,
        error: error instanceof Error ? error.message : String(error),
        error_type: error instanceof Error ? error.name : "Error",
        is_interrupt: isInterrupt === true,
        is_timeout: false,
      });
    };
  }

  private createPermissionHook(
    hook: IndividualHookConfig,
  ): PermissionDecisionHook {
    return async ({ toolName, args }) => {
      if (this.disabled || !matchesPattern(toolName, hook.matcher)) {
        return { kind: "pass" };
      }
      const run = await this.runCommandHook(hook, {
        hook_event_name: "PermissionRequest",
        tool_name: toolName,
        tool_input: args,
      });
      if (run.status !== "success") return { kind: "pass" };
      const decision = parsePermissionDecision(run.rawStdout);
      if (!decision) return { kind: "pass" };
      return decision;
    };
  }

  private createUserPromptSubmitHook(
    hook: IndividualHookConfig,
  ): UserPromptSubmitHook {
    return async ({ prompt, permissionMode, cwd, signal }) => {
      if (this.disabled || !matchesPattern(prompt, hook.matcher)) {
        return undefined;
      }
      const run = await this.runCommandHook(
        hook,
        {
          hook_event_name: "UserPromptSubmit",
          prompt,
          permission_mode: permissionMode,
          cwd,
        },
        signal,
      );
      if (run.status === "blocking") {
        return {
          blockingError: {
            blockingError: run.stderr || run.stdout || "Prompt blocked by hook.",
          },
        };
      }
      if (run.status !== "success") return undefined;
      const parsed = readHookSpecificOutput(run.rawStdout);
      if (parsed.invalid) this.recordHookOutputIssue(run, parsed.invalid);
      const additionalContext = parsed.explicit
        ? parsed.output?.additionalContext
        : run.stdout.trim() || undefined;
      if (additionalContext === undefined) return undefined;
      return {
        additionalContexts: [redactSecrets(additionalContext)],
      };
    };
  }

  private createStopHook(hook: IndividualHookConfig): StopHookHandler {
    return {
      name: hookCommandLabel(hook),
      run: async (request) => {
        if (this.disabled || !matchesPattern("", hook.matcher)) {
          return allowStopOutcome();
        }
        const run = await this.runCommandHook(hook, stopInput("Stop", request));
        if (run.status === "blocking") {
          const reason = run.stderr || run.stdout || "Stop hook blocked.";
          return {
            shouldStop: false,
            shouldBlock: true,
            blockReason: firstLine(reason),
            continuationFragments: [reason],
          };
        }
        return allowStopOutcome();
      },
    };
  }

  private createStopFailureHook(hook: IndividualHookConfig): StopHookHandler {
    return {
      name: hookCommandLabel(hook),
      run: async (request) => {
        const error = classifyStopFailure(request);
        if (this.disabled || !matchesPattern(error, hook.matcher)) {
          return allowStopOutcome();
        }
        await this.runCommandHook(hook, {
          ...stopInput("StopFailure", request),
          error,
        });
        return allowStopOutcome();
      },
    };
  }

  private createLifecycleHook(
    hook: IndividualHookConfig,
  ): (
    input: PreCompactHookInput | PostCompactHookInput | SessionStartHookInput,
    signal?: AbortSignal,
  ) => Promise<HookResult> {
    return async (input, signal) => {
      const matchQuery =
        input.hook_event_name === "SessionStart" ? input.source : input.trigger;
      if (this.disabled || !matchesPattern(matchQuery, hook.matcher)) {
        return { succeeded: true, output: "", command: hook.command.command };
      }
      const run = await this.runCommandHook(
        hook,
        input as unknown as Record<string, unknown>,
        signal,
      );
      const specific = parseHookSpecificOutput(run.rawStdout);
      return {
        succeeded: run.status === "success",
        output: run.status === "success" ? run.stdout : run.stderr || run.stdout,
        command: hookCommandLabel(hook),
        ...(specific?.additionalContext !== undefined
          ? { additionalContexts: [redactSecrets(specific.additionalContext)] }
          : {}),
      };
    };
  }

  private async runCommandHook(
    hook: IndividualHookConfig,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HookCommandRunDiagnostic> {
    const startedAtUnixMs = Date.now();
    if (this.disabled) {
      const skipped = this.recordDiagnostic(hook, {
        status: "skipped",
        stdout: "",
        stderr: "",
        durationMs: 0,
      }, startedAtUnixMs);
      return skipped;
    }
    const result = await runShellCommand({
      command: hook.command.command,
      cwd: this.opts.cwd,
      env: this.opts.env,
      shellPath: this.opts.shellPath,
      stdin: `${JSON.stringify(input)}\n`,
      timeoutMs: hook.command.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS,
      signal,
    });
    return this.recordDiagnostic(hook, result, startedAtUnixMs);
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
      ...(sanitizedResult.error !== undefined ? { error: sanitizedResult.error } : {}),
      startedAtUnixMs,
    };
    this.diagnostics = [diagnostic, ...this.diagnostics].slice(
      0,
      MAX_DIAGNOSTICS,
    );
    return {
      ...diagnostic,
      rawStdout: result.stdout,
      rawStderr: result.stderr,
      ...(result.error !== undefined ? { rawError: result.error } : {}),
    };
  }

  private recordHookOutputIssue(
    run: HookCommandRunDiagnostic,
    message: string,
  ): void {
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
}

export function flattenHooks(
  config: HooksMap | undefined,
  sourcePath: string,
): readonly IndividualHookConfig[] {
  if (!config) return [];
  const out: IndividualHookConfig[] = [];
  for (const event of HOOK_EVENT_NAMES) {
    const matchers = config[event] ?? [];
    for (const matcher of matchers) {
      const matcherEnabled = matcher.enabled !== false;
      for (const command of matcher.hooks) {
        out.push({
          event,
          ...(matcher.matcher !== undefined ? { matcher: matcher.matcher } : {}),
          command,
          source: "config",
          sourcePath,
          enabled: matcherEnabled && command.enabled !== false,
          index: out.length,
        });
      }
    }
  }
  return out;
}

export function groupHooksByEvent(
  hooks: readonly IndividualHookConfig[],
): ReadonlyMap<HookEventName, readonly IndividualHookConfig[]> {
  const map = new Map<HookEventName, IndividualHookConfig[]>();
  for (const event of HOOK_EVENT_NAMES) map.set(event, []);
  for (const hook of hooks) {
    map.get(hook.event)?.push(hook);
  }
  return map;
}

export function hookDisplayText(hook: IndividualHookConfig): string {
  return hookCommandLabel(hook);
}

function hookCommandLabel(hook: IndividualHookConfig): string {
  return redactSecrets(hook.command.statusMessage ?? hook.command.command);
}

function sanitizeCommandRunResult(result: CommandRunResult): CommandRunResult {
  return {
    ...result,
    stdout: redactSecrets(result.stdout),
    stderr: redactSecrets(result.stderr),
    ...(result.error !== undefined ? { error: redactSecrets(result.error) } : {}),
  };
}

export function matchesPattern(matchQuery: string, matcher?: string): boolean {
  if (matcher === undefined || matcher.trim() === "" || matcher === "*") {
    return true;
  }
  if (/^[a-zA-Z0-9_.|-]+$/.test(matcher)) {
    if (matcher.includes("|")) {
      return matcher.split("|").map((p) => p.trim()).includes(matchQuery);
    }
    return matchQuery === matcher;
  }
  try {
    return new RegExp(matcher).test(matchQuery);
  } catch {
    return false;
  }
}

function parseHookSpecificOutput(stdout: string): HookSpecificOutput | undefined {
  return readHookSpecificOutput(stdout).output;
}

function readHookSpecificOutput(stdout: string): ParsedHookSpecificOutput {
  const raw = stdout.trim();
  if (!raw.startsWith("{")) return { explicit: false };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {
        explicit: true,
        invalid: "hook output JSON must be an object",
      };
    }
    const rawSpecific =
      parsed.hookSpecificOutput === undefined
        ? parsed
        : isRecord(parsed.hookSpecificOutput)
          ? parsed.hookSpecificOutput
          : undefined;
    if (!rawSpecific) {
      return {
        explicit: true,
        invalid: "hookSpecificOutput must be an object",
      };
    }
    const { output, invalid } = normalizeHookSpecificOutput(rawSpecific);
    return {
      explicit: true,
      output,
      ...(invalid.length > 0 ? { invalid: invalid.join("; ") } : {}),
    };
  } catch {
    return {
      explicit: true,
      invalid: "hook output JSON could not be parsed",
    };
  }
}

function normalizeHookSpecificOutput(
  raw: Record<string, unknown>,
): { output: HookSpecificOutput; invalid: string[] } {
  const invalid: string[] = [];
  const output: {
    hookEventName?: string;
    permissionDecision?: HookPermissionBehavior;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    decision?: {
      behavior?: string;
      updatedInput?: Record<string, unknown>;
      message?: string;
    };
  } = {};

  if (typeof raw.hookEventName === "string") {
    output.hookEventName = raw.hookEventName;
  }
  if (raw.permissionDecision !== undefined) {
    if (isHookPermissionBehavior(raw.permissionDecision)) {
      output.permissionDecision = raw.permissionDecision;
    } else {
      invalid.push("permissionDecision must be allow, deny, or ask");
    }
  }
  if (raw.permissionDecisionReason !== undefined) {
    if (typeof raw.permissionDecisionReason === "string") {
      output.permissionDecisionReason = raw.permissionDecisionReason;
    } else {
      invalid.push("permissionDecisionReason must be a string");
    }
  }
  if (raw.updatedInput !== undefined) {
    if (isRecord(raw.updatedInput)) {
      output.updatedInput = raw.updatedInput;
    } else {
      invalid.push("updatedInput must be an object");
    }
  }
  if (raw.additionalContext !== undefined) {
    if (typeof raw.additionalContext === "string") {
      output.additionalContext = raw.additionalContext;
    } else {
      invalid.push("additionalContext must be a string");
    }
  }
  if (raw.decision !== undefined) {
    if (isRecord(raw.decision)) {
      const decision: {
        behavior?: string;
        updatedInput?: Record<string, unknown>;
        message?: string;
      } = {};
      if (typeof raw.decision.behavior === "string") {
        decision.behavior = raw.decision.behavior;
      }
      if (raw.decision.updatedInput !== undefined) {
        if (isRecord(raw.decision.updatedInput)) {
          decision.updatedInput = raw.decision.updatedInput;
        } else {
          invalid.push("decision.updatedInput must be an object");
        }
      }
      if (raw.decision.message !== undefined) {
        if (typeof raw.decision.message === "string") {
          decision.message = raw.decision.message;
        } else {
          invalid.push("decision.message must be a string");
        }
      }
      output.decision = decision;
    } else {
      invalid.push("decision must be an object");
    }
  }

  return { output, invalid };
}

function isHookPermissionBehavior(
  value: unknown,
): value is HookPermissionBehavior {
  return value === "allow" || value === "deny" || value === "ask";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePermissionDecision(
  stdout: string,
): PermissionDecisionResult | undefined {
  const specific = parseHookSpecificOutput(stdout);
  const decision = specific?.decision;
  if (!decision) return undefined;
  if (decision.behavior === "allow") {
    return {
      kind: "allow",
      ...(decision.updatedInput !== undefined
        ? { updatedArgs: decision.updatedInput }
        : {}),
    };
  }
  if (decision.behavior === "deny") {
    return {
      kind: "deny",
      ...(decision.message !== undefined
        ? { reason: redactSecrets(decision.message) }
        : {}),
    };
  }
  return undefined;
}

async function runShellCommand(opts: {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shellPath: string;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<CommandRunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(opts.shellPath, ["-c", opts.command], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let abortListener: (() => void) | null = null;
    const finish = (
      result: Omit<CommandRunResult, "durationMs" | "stdout" | "stderr">,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (abortListener !== null && opts.signal !== undefined) {
        opts.signal.removeEventListener("abort", abortListener);
        abortListener = null;
      }
      resolve({
        ...result,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ status: "timeout", error: "hook timed out" });
    }, opts.timeoutMs);
    if (opts.signal !== undefined) {
      abortListener = () => {
        child.kill("SIGTERM");
        finish({ status: "skipped", error: "hook aborted" });
      };
      opts.signal.addEventListener("abort", abortListener, { once: true });
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      finish({
        status: "non_blocking_error",
        error: err.message,
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish({ status: "success", exitCode: 0 });
        return;
      }
      if (code === 2) {
        finish({ status: "blocking", exitCode: 2 });
        return;
      }
      finish({
        status: "non_blocking_error",
        ...(code !== null ? { exitCode: code } : {}),
      });
    });
    child.stdin.on("error", () => {
      // Hooks are allowed to exit without reading stdin. Keep the command's
      // exit status authoritative instead of surfacing EPIPE as an unhandled
      // process error.
    });
    child.stdin.end(opts.stdin);
  });
}

function allowStopOutcome(): StopHookOutcome {
  return {
    shouldStop: true,
    shouldBlock: false,
    continuationFragments: [],
  };
}

function stopInput(
  event: "Stop" | "StopFailure",
  request: StopRequest,
): Record<string, unknown> {
  return {
    hook_event_name: event,
    session_id: request.sessionId,
    turn_id: request.turnId,
    cwd: request.cwd,
    model: request.model,
    permission_mode: request.permissionMode,
    stop_hook_active: request.stopHookActive,
    last_assistant_message: request.lastAssistantMessage ?? "",
  };
}

function classifyStopFailure(request: StopRequest): string {
  const text = request.lastAssistantMessage ?? "";
  if (/rate limit|429/i.test(text)) return "rate_limit";
  if (/auth|api key|401|403/i.test(text)) return "authentication_failed";
  if (/billing|quota/i.test(text)) return "billing_error";
  if (/too long|max.*token|context/i.test(text)) return "max_output_tokens";
  if (/server|500|502|503|504/i.test(text)) return "server_error";
  if (/invalid request|400/i.test(text)) return "invalid_request";
  return "unknown";
}

function defaultHookInput(
  event: HookEventName,
  cwd: string,
): Record<string, unknown> {
  switch (event) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionRequest":
      return {
        hook_event_name: event,
        tool_name: "Read",
        tool_input: {},
        tool_use_id: "test",
      };
    case "UserPromptSubmit":
      return {
        hook_event_name: event,
        prompt: "test",
        permission_mode: "default",
        cwd,
      };
    case "SessionStart":
      return { hook_event_name: event, source: "startup", cwd };
    case "Stop":
    case "StopFailure":
      return { hook_event_name: event, cwd, error: "unknown" };
    case "PreCompact":
      return {
        hook_event_name: event,
        trigger: "manual",
        custom_instructions: null,
      };
    case "PostCompact":
      return {
        hook_event_name: event,
        trigger: "manual",
        compact_summary: "",
      };
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() || "Hook blocked.";
}
