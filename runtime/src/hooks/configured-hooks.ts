import { join } from "node:path";

import type { HookEventName, HooksMap } from "../config/schema.js";
import {
  InvalidHooksConfigError,
  validateHooksConfig,
} from "../config/schema.js";
import type {
  PermissionDecisionHook,
  PermissionDecisionHookInput,
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
import { HookEngine, matchesPattern } from "./engine/dispatcher.js";
import { flattenHooks, groupHooksByEvent } from "./engine/discovery.js";
import {
  readHookSpecificOutput,
  type HookSpecificOutput,
} from "./engine/output-parser.js";
import type {
  HookCommandRunDiagnostic,
  HookRunDiagnostic,
  HookRunStatus,
  IndividualHookConfig,
} from "./engine/types.js";

export { flattenHooks, groupHooksByEvent, matchesPattern };
export type {
  HookCommandRunDiagnostic,
  HookRunDiagnostic,
  HookRunStatus,
  IndividualHookConfig,
};

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

export class ConfiguredHooksRuntime {
  private readonly engine: HookEngine;
  private validationIssues: HookValidationIssue[] = [];
  private target: HookInstallTarget | null = null;

  constructor(private readonly opts: ConfiguredHooksRuntimeOptions) {
    this.engine = new HookEngine({
      cwd: opts.cwd,
      env: opts.env,
      shellPath: opts.shellPath,
      sourcePath: this.sourcePath(),
    });
  }

  attachTarget(target: HookInstallTarget): void {
    this.target = target;
    this.rebuildTarget();
  }

  load(raw: HooksMap | undefined): void {
    try {
      this.engine.load(validateHooksConfig(raw));
      this.validationIssues = [];
    } catch (err) {
      this.engine.load(undefined);
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
    this.engine.setDisabled(disabled);
  }

  isDisabled(): boolean {
    return this.engine.isDisabled();
  }

  listHooks(): readonly IndividualHookConfig[] {
    return this.engine.listHooks();
  }

  issues(): readonly HookValidationIssue[] {
    return this.validationIssues;
  }

  latestDiagnostics(): readonly HookRunDiagnostic[] {
    return this.engine.latestDiagnostics();
  }

  clearDiagnostics(): void {
    this.engine.clearDiagnostics();
  }

  sourcePath(): string {
    return join(this.opts.agencHome, "config.toml");
  }

  async testHook(
    hook: IndividualHookConfig,
    input: Record<string, unknown> = defaultHookInput(hook.event, this.opts.cwd),
  ): Promise<HookRunDiagnostic> {
    const result = await this.runCommandHook(hook, input);
    return this.latestDiagnostics().find((d) => d.id === result.id) ?? result;
  }

  private rebuildTarget(): void {
    const target = this.target;
    if (!target) return;
    let hasPermissionRequestHook = false;
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
          hasPermissionRequestHook = true;
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
    if (hasPermissionRequestHook) {
      target.permissionDecisionHooks.push(this.createPermissionHook());
    }
  }

  private createPreToolUseHook(hook: IndividualHookConfig): PreToolUseHook {
    return async ({ invocation, tool, args }) => {
      const toolName = tool.name;
      if (this.isDisabled() || !matchesPattern(toolName, hook.matcher)) {
        return { kind: "continue" };
      }
      const result = await this.runCommandHook(hook, {
        ...toolInvocationHookContext(invocation, this.opts.cwd),
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: args,
        tool_use_id: invocation.callId,
      });
      if (result.status === "blocking") {
        return { kind: "deny", reason: result.stderr || result.stdout };
      }
      if (result.status !== "success") return { kind: "continue" };
      const parsed = this.readStructuredOutput(result);
      const specific = parsed.output;
      const legacyBlockReason = legacyBlockReasonFor(
        specific,
        "PreToolUse",
        (message) => this.recordHookOutputIssue(result, message),
      );
      if (legacyBlockReason !== null) {
        return { kind: "deny", reason: legacyBlockReason };
      }
      const unsupported = unsupportedPreToolUseOutput(specific);
      if (unsupported !== null) this.recordHookOutputIssue(result, unsupported);
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
      if (this.isDisabled() || !matchesPattern(toolName, hook.matcher)) {
        return { kind: "continue" };
      }
      const run = await this.runCommandHook(hook, {
        ...toolInvocationHookContext(invocation, this.opts.cwd),
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
      const specific = this.readStructuredOutput(run).output;
      const legacyBlockReason = legacyBlockReasonFor(
        specific,
        "PostToolUse",
        (message) => this.recordHookOutputIssue(run, message),
      );
      if (legacyBlockReason !== null) {
        return { kind: "hook_blocking_error", blockingError: legacyBlockReason };
      }
      if (specific?.continueProcessing === false) {
        return {
          kind: "preventContinuation",
          ...(specific.stopReason !== undefined
            ? { stopReason: redactSecrets(specific.stopReason) }
            : {}),
        };
      }
      if (specific?.suppressOutput === true) {
        this.recordHookOutputIssue(
          run,
          "PostToolUse hook returned unsupported suppressOutput",
        );
      }
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
      if (this.isDisabled() || !matchesPattern(toolName, hook.matcher)) return;
      await this.runCommandHook(hook, {
        ...toolInvocationHookContext(invocation, this.opts.cwd),
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

  private createPermissionHook(): PermissionDecisionHook {
    return async (input) => {
      const { toolName, args } = input;
      if (this.isDisabled()) {
        return { kind: "pass" };
      }
      const runs = await this.engine.dispatch(
        "PermissionRequest",
        [toolName, ...(input.matcherAliases ?? [])],
        {
          ...permissionDecisionHookInput(input, this.opts.cwd),
          hook_event_name: "PermissionRequest",
          tool_name: toolName,
          tool_input: args,
        },
        input.signal,
      );
      let allow: PermissionDecisionResult | undefined;
      for (const { run } of runs) {
        if (run.status === "blocking") {
          const reason = trimmedReason(run.stderr) ?? trimmedReason(run.stdout);
          if (reason === undefined) {
            this.recordHookOutputIssue(
              run,
              "PermissionRequest hook exited with code 2 but did not write a denial reason to stderr",
            );
            continue;
          }
          return { kind: "deny", reason: redactSecrets(reason) };
        }
        if (run.status !== "success") continue;
        const decision = this.parsePermissionDecision(run);
        if (!decision) continue;
        if (decision.kind === "deny") return decision;
        if (decision.kind === "allow") allow = decision;
      }
      return allow ?? { kind: "pass" };
    };
  }

  private createUserPromptSubmitHook(
    hook: IndividualHookConfig,
  ): UserPromptSubmitHook {
    return async ({ prompt, permissionMode, cwd, signal }) => {
      if (this.isDisabled()) {
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
      const parsed = this.readStructuredOutput(run);
      const legacyBlockReason = legacyBlockReasonFor(
        parsed.output,
        "UserPromptSubmit",
        (message) => this.recordHookOutputIssue(run, message),
      );
      if (legacyBlockReason !== null) {
        return { blockingError: { blockingError: legacyBlockReason } };
      }
      if (parsed.output?.continueProcessing === false) {
        return {
          preventContinuation: true,
          ...(parsed.output.stopReason !== undefined
            ? { stopReason: redactSecrets(parsed.output.stopReason) }
            : {}),
        };
      }
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
        if (this.isDisabled()) {
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
        if (run.status === "success") {
          const parsed = this.readStructuredOutput(run);
          const legacyBlockReason = legacyBlockReasonFor(
            parsed.output,
            "Stop",
            (message) => this.recordHookOutputIssue(run, message),
          );
          if (legacyBlockReason !== null) {
            return {
              shouldStop: false,
              shouldBlock: true,
              blockReason: firstLine(legacyBlockReason),
              continuationFragments: [legacyBlockReason],
            };
          }
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
        if (this.isDisabled() || !matchesPattern(error, hook.matcher)) {
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
      if (this.isDisabled() || !matchesPattern(matchQuery, hook.matcher)) {
        return { succeeded: true, output: "", command: hook.command.command };
      }
      const run = await this.runCommandHook(
        hook,
        input as unknown as Record<string, unknown>,
        signal,
      );
      const parsed = this.readStructuredOutput(run);
      const specific = parsed.output;
      const output =
        specific?.suppressOutput === true
          ? ""
          : run.status === "success"
            ? run.stdout
            : run.stderr || run.stdout;
      return {
        succeeded:
          run.status === "success" && specific?.continueProcessing !== false,
        output,
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
    return this.engine.runCommandHook(hook, input, signal);
  }

  private recordHookOutputIssue(
    run: HookCommandRunDiagnostic,
    message: string,
  ): void {
    this.engine.recordHookOutputIssue(run, message);
  }

  private readStructuredOutput(
    run: HookCommandRunDiagnostic,
  ): ReturnType<typeof readHookSpecificOutput> {
    const parsed = readHookSpecificOutput(run.rawStdout, run.event);
    if (parsed.invalid) this.recordHookOutputIssue(run, parsed.invalid);
    return parsed;
  }

  private parsePermissionDecision(
    run: HookCommandRunDiagnostic,
  ): PermissionDecisionResult | undefined {
    const specific = this.readStructuredOutput(run).output;
    const unsupported = unsupportedPermissionRequestOutput(specific);
    if (unsupported !== null) {
      this.recordHookOutputIssue(run, unsupported);
      return undefined;
    }
    const decision = specific?.decision;
    if (!decision) return undefined;
    if (decision.behavior === "allow") {
      return {
        kind: "allow",
      };
    }
    if (decision.behavior === "deny") {
      return {
        kind: "deny",
        reason: redactSecrets(
          trimmedReason(decision.message) ??
            "PermissionRequest hook denied approval",
        ),
      };
    }
    this.recordHookOutputIssue(
      run,
      "PermissionRequest hook returned unsupported decision behavior",
    );
    return undefined;
  }
}

export function hookDisplayText(hook: IndividualHookConfig): string {
  return hookCommandLabel(hook);
}

function hookCommandLabel(hook: IndividualHookConfig): string {
  return redactSecrets(hook.command.statusMessage ?? hook.command.command);
}

function permissionDecisionHookInput(
  input: PermissionDecisionHookInput,
  fallbackCwd: string,
): Record<string, unknown> {
  return {
    session_id: input.sessionId ?? "",
    turn_id: input.turnId ?? "",
    transcript_path: input.transcriptPath ?? null,
    cwd: input.cwd ?? fallbackCwd,
    model: input.model ?? "unknown",
    permission_mode: input.permissionMode ?? "default",
  };
}

function toolInvocationHookContext(
  invocation: unknown,
  fallbackCwd: string,
): Record<string, unknown> {
  const root = asRecord(invocation);
  const session = asRecord(root?.session);
  const turn = asRecord(root?.turn);
  return {
    session_id: stringValue(session?.conversationId) ?? "",
    turn_id: stringValue(turn?.subId) ?? "",
    transcript_path: stringValue(session?.transcriptPath) ?? null,
    cwd: stringValue(turn?.cwd) ?? fallbackCwd,
    model:
      stringValue(asRecord(turn?.modelInfo)?.slug) ??
      stringValue(asRecord(turn?.collaborationMode)?.model) ??
      stringValue(asRecord(turn?.config)?.model) ??
      "unknown",
    permission_mode: stringValue(turn?.permissionMode) ?? "default",
  };
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

function legacyBlockReasonFor(
  output: HookSpecificOutput | undefined,
  event: "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop",
  recordIssue: (message: string) => void,
): string | null {
  const decision = output?.legacyDecision;
  const reason = trimmedReason(output?.reason);
  if (decision === "block") {
    if (reason === undefined) {
      recordIssue(`${event} hook returned decision:block without a non-empty reason`);
      return null;
    }
    return redactSecrets(reason);
  }
  if (decision !== undefined) {
    recordIssue(`${event} hook returned unsupported decision:${decision}`);
    return null;
  }
  if (
    reason !== undefined &&
    (event === "PreToolUse" || event === "PostToolUse")
  ) {
    recordIssue(`${event} hook returned reason without decision`);
  }
  return null;
}

function unsupportedPreToolUseOutput(
  output: HookSpecificOutput | undefined,
): string | null {
  if (output?.continueProcessing === false) {
    return "PreToolUse hook returned unsupported continue:false";
  }
  if (output?.stopReason !== undefined) {
    return "PreToolUse hook returned unsupported stopReason";
  }
  if (output?.suppressOutput === true) {
    return "PreToolUse hook returned unsupported suppressOutput";
  }
  return null;
}

function unsupportedPermissionRequestOutput(
  output: HookSpecificOutput | undefined,
): string | null {
  if (output?.continueProcessing === false) {
    return "PermissionRequest hook returned unsupported continue:false";
  }
  if (output?.stopReason !== undefined) {
    return "PermissionRequest hook returned unsupported stopReason";
  }
  if (output?.suppressOutput === true) {
    return "PermissionRequest hook returned unsupported suppressOutput";
  }
  const decision = output?.decision;
  if (decision?.updatedInput !== undefined) {
    return "PermissionRequest hook returned unsupported updatedInput";
  }
  if (decision?.updatedPermissions !== undefined) {
    return "PermissionRequest hook returned unsupported updatedPermissions";
  }
  if (decision?.interrupt === true) {
    return "PermissionRequest hook returned unsupported interrupt:true";
  }
  return null;
}

function trimmedReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
