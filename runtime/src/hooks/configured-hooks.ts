import { randomUUID } from "node:crypto";
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
  HookPermissionResult,
  PreToolUseDecision,
  PreToolUseHook,
} from "../tools/hooks.js";
import type {
  StopHookHandler,
  StopHookOutcome,
  StopRequest,
} from "../phases/stop-hooks.js";
import { hookMatcherInputsForToolName } from "../permissions/hook-event-schedule.js";
import type { UserPromptSubmitHook } from "./user-prompt-submit.js";
import type {
  HookInput,
  HookResult,
  NotificationHookInput,
  PostCompactHookInput,
  PreCompactHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  SubagentStopHookInput,
} from "../llm/hooks/types.js";
import { redactSecrets } from "../secrets/index.js";
import { asRecord } from "../utils/record.js";
import { nonEmptyString as stringValue } from "../utils/stringUtils.js";
import { HookEngine, matchesPattern } from "./engine/dispatcher.js";
import { groupHooksByEvent } from "./engine/discovery.js";
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
import {
  resolveConfiguredHookSources,
  type ConfiguredHookAuthoritySnapshot,
} from "./configured-hook-sources.js";
import type { HookRuntimeAuthority } from "./runtime-policy.js";
import type { HookExecutionAuthority } from "./execution-authority.js";

export type { ConfiguredHookAuthoritySnapshot } from "./configured-hook-sources.js";

export { groupHooksByEvent, matchesPattern };
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
  ) => () => void;
  readonly addPostCompactHook?: (
    hook: (
      input: PostCompactHookInput,
      signal?: AbortSignal,
    ) => Promise<HookResult>,
  ) => () => void;
  readonly addSessionStartHook?: (
    hook: (
      input: SessionStartHookInput,
      signal?: AbortSignal,
    ) => Promise<HookResult>,
  ) => () => void;
  readonly addSubagentStopHook?: (
    hook: (
      input: SubagentStopHookInput,
      signal?: AbortSignal,
    ) => Promise<HookResult>,
  ) => () => void;
  readonly addSessionEndHook?: (
    hook: (
      input: SessionEndHookInput,
      signal?: AbortSignal,
    ) => Promise<HookResult>,
  ) => () => void;
  readonly addNotificationHook?: (
    hook: (
      input: NotificationHookInput,
      signal?: AbortSignal,
    ) => Promise<HookResult>,
  ) => () => void;
  readonly clearConfiguredLifecycleHooks?: () => void;
}

export interface ConfiguredHooksRuntimeOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly agencHome: string;
  readonly shellPath: string;
  readonly commandWrapperArgv?: readonly string[];
  readonly sandboxExecutionBroker?: import("../sandbox/execution-broker.js").SandboxExecutionBrokerLike;
  readonly executionAdmission?: import("../budget/admission-client.js").ExecutionAdmissionClient;
  readonly admissionRequired?: boolean;
  /** Immutable authority owned by the session whose hooks this runtime runs. */
  readonly runtimeOptions?: HookRuntimeAuthority;
  /** Sole session-owned decision point for every configured command effect. */
  readonly executionAuthority: HookExecutionAuthority;
}

interface ManagedHookInstallation {
  readonly target: HookInstallTarget;
  readonly preToolUseHooks: PreToolUseHook[];
  readonly postToolUseHooks: PostToolUseHook[];
  readonly failureToolUseHooks: PostToolUseFailureHook[];
  readonly permissionDecisionHooks: PermissionDecisionHook[];
  readonly userPromptSubmitHooks: UserPromptSubmitHook[];
  readonly stopHooks: StopHookHandler[];
  readonly stopFailureHooks: StopHookHandler[];
  readonly lifecycleDisposers: Array<() => void>;
  readonly insertionIndexes: ManagedHookInsertionIndexes;
}

interface ManagedHookInsertionIndexes {
  readonly preToolUseHooks: number;
  readonly postToolUseHooks: number;
  readonly failureToolUseHooks: number;
  readonly permissionDecisionHooks: number;
  readonly userPromptSubmitHooks: number;
  readonly stopHooks: number;
  readonly stopFailureHooks: number;
}

function removeInstalledHooks<T>(target: T[], installed: readonly T[]): void {
  if (installed.length === 0) return;
  const managed = new Set(installed);
  let writeIndex = 0;
  for (const hook of target) {
    if (managed.has(hook)) continue;
    target[writeIndex] = hook;
    writeIndex += 1;
  }
  target.length = writeIndex;
}

function managedInsertionIndex<T>(
  target: readonly T[],
  installed: readonly T[],
  fallback: number,
): number {
  const indexes = installed
    .map((hook) => target.indexOf(hook))
    .filter((index) => index >= 0);
  return indexes.length > 0
    ? Math.min(...indexes)
    : Math.min(fallback, target.length);
}

function insertManagedHook<T>(
  target: T[],
  installed: T[],
  insertionIndex: number,
  hook: T,
): void {
  target.splice(
    Math.min(insertionIndex + installed.length, target.length),
    0,
    hook,
  );
  installed.push(hook);
}

export class ConfiguredHooksRuntime {
  private readonly engine: HookEngine;
  private validationIssues: HookValidationIssue[] = [];
  private target: HookInstallTarget | null = null;
  private configAuthority: ConfiguredHookAuthoritySnapshot | undefined;
  private pluginHooks: HooksMap | undefined;
  private managedInstallation: ManagedHookInstallation | undefined;

  constructor(private readonly opts: ConfiguredHooksRuntimeOptions) {
    this.engine = new HookEngine({
      cwd: opts.cwd,
      env: opts.env,
      shellPath: opts.shellPath,
      ...(opts.commandWrapperArgv !== undefined
        ? { commandWrapperArgv: opts.commandWrapperArgv }
        : {}),
      sourcePath: this.sourcePath(),
      ...(opts.sandboxExecutionBroker !== undefined
        ? { sandboxExecutionBroker: opts.sandboxExecutionBroker }
        : {}),
      ...(opts.executionAdmission !== undefined
        ? { executionAdmission: opts.executionAdmission }
        : {}),
      ...(opts.admissionRequired !== undefined
        ? { admissionRequired: opts.admissionRequired }
        : {}),
      ...(opts.runtimeOptions !== undefined
        ? { runtimeOptions: opts.runtimeOptions }
        : {}),
    });
  }

  attachTarget(target: HookInstallTarget): void {
    if (this.target !== target) this.uninstallManagedHooks();
    this.target = target;
    this.rebuildTarget();
  }

  /** Replace canonical config authority without disturbing plugin hooks. */
  loadConfigAuthority(snapshot: ConfiguredHookAuthoritySnapshot): void {
    this.configAuthority = snapshot;
    this.refreshSources();
  }

  /** Replace explicit plugin command hooks without reconstructing config. */
  setPluginHooks(hooks: HooksMap | undefined): void {
    this.pluginHooks = hooks;
    this.refreshSources();
  }

  /** @internal Test-only raw loader. Production must bind source authority. */
  loadForTesting(raw: HooksMap | undefined): void {
    this.configAuthority = undefined;
    this.pluginHooks = undefined;
    this.loadResolved(raw);
  }

  private refreshSources(): void {
    this.loadResolved(
      resolveConfiguredHookSources(this.configAuthority, this.pluginHooks),
    );
  }

  private loadResolved(raw: HooksMap | undefined): void {
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

  /** Immutable owner policy; unlike `isDisabled`, callers cannot toggle it. */
  isHardSuppressed(): boolean {
    return this.engine.isHardSuppressed();
  }

  /** Effective execution state across mutable and immutable policy. */
  isExecutionSuppressed(): boolean {
    return this.engine.isExecutionSuppressed();
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
    input: Record<string, unknown> = defaultHookInput(
      hook.event,
      this.opts.cwd,
    ),
  ): Promise<HookRunDiagnostic> {
    const result = await this.runCommandHook(hook, input);
    return this.latestDiagnostics().find((d) => d.id === result.id) ?? result;
  }

  private rebuildTarget(): void {
    const priorInsertionIndexes = this.uninstallManagedHooks();
    const target = this.target;
    if (!target) return;
    const insertionIndexes: ManagedHookInsertionIndexes =
      priorInsertionIndexes ?? {
        preToolUseHooks: target.preToolUseHooks.length,
        postToolUseHooks: target.postToolUseHooks.length,
        failureToolUseHooks: target.failureToolUseHooks.length,
        permissionDecisionHooks: target.permissionDecisionHooks.length,
        userPromptSubmitHooks: target.userPromptSubmitHooks.length,
        stopHooks: target.stopHooks.length,
        stopFailureHooks: target.stopFailureHooks.length,
      };
    const installation: ManagedHookInstallation = {
      target,
      preToolUseHooks: [],
      postToolUseHooks: [],
      failureToolUseHooks: [],
      permissionDecisionHooks: [],
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
      lifecycleDisposers: [],
      insertionIndexes,
    };
    this.managedInstallation = installation;
    let hasPermissionRequestHook = false;

    for (const hook of this.listHooks()) {
      if (!hook.enabled) continue;
      switch (hook.event) {
        case "PreToolUse": {
          const installed = this.createPreToolUseHook(hook);
          insertManagedHook(
            target.preToolUseHooks,
            installation.preToolUseHooks,
            insertionIndexes.preToolUseHooks,
            installed,
          );
          break;
        }
        case "PostToolUse": {
          const installed = this.createPostToolUseHook(hook);
          insertManagedHook(
            target.postToolUseHooks,
            installation.postToolUseHooks,
            insertionIndexes.postToolUseHooks,
            installed,
          );
          break;
        }
        case "PostToolUseFailure": {
          const installed = this.createFailureHook(hook);
          insertManagedHook(
            target.failureToolUseHooks,
            installation.failureToolUseHooks,
            insertionIndexes.failureToolUseHooks,
            installed,
          );
          break;
        }
        case "PermissionRequest":
          hasPermissionRequestHook = true;
          break;
        case "UserPromptSubmit": {
          const installed = this.createUserPromptSubmitHook(hook);
          insertManagedHook(
            target.userPromptSubmitHooks,
            installation.userPromptSubmitHooks,
            insertionIndexes.userPromptSubmitHooks,
            installed,
          );
          break;
        }
        case "Stop": {
          const installed = this.createStopHook(hook);
          insertManagedHook(
            target.stopHooks,
            installation.stopHooks,
            insertionIndexes.stopHooks,
            installed,
          );
          break;
        }
        case "StopFailure": {
          const installed = this.createStopFailureHook(hook);
          insertManagedHook(
            target.stopFailureHooks,
            installation.stopFailureHooks,
            insertionIndexes.stopFailureHooks,
            installed,
          );
          break;
        }
        case "PreCompact":
          this.trackLifecycleRegistration(
            installation,
            target.addPreCompactHook?.(this.createLifecycleHook(hook)),
          );
          break;
        case "PostCompact":
          this.trackLifecycleRegistration(
            installation,
            target.addPostCompactHook?.(this.createLifecycleHook(hook)),
          );
          break;
        case "SessionStart":
          this.trackLifecycleRegistration(
            installation,
            target.addSessionStartHook?.(this.createLifecycleHook(hook)),
          );
          break;
        case "SubagentStop":
          this.trackLifecycleRegistration(
            installation,
            target.addSubagentStopHook?.(
              this.createGenericLifecycleHook(hook, (input) =>
                input.hook_event_name === "SubagentStop"
                  ? (input.agent_type ?? input.task_name)
                  : "",
              ),
            ),
          );
          break;
        case "SessionEnd":
          this.trackLifecycleRegistration(
            installation,
            target.addSessionEndHook?.(
              this.createGenericLifecycleHook(hook, (input) =>
                input.hook_event_name === "SessionEnd" ? input.reason : "",
              ),
            ),
          );
          break;
        case "Notification":
          this.trackLifecycleRegistration(
            installation,
            target.addNotificationHook?.(
              this.createGenericLifecycleHook(hook, (input) =>
                input.hook_event_name === "Notification"
                  ? input.notification_type
                  : "",
              ),
            ),
          );
          break;
      }
    }
    if (hasPermissionRequestHook) {
      const installed = this.createPermissionHook();
      insertManagedHook(
        target.permissionDecisionHooks,
        installation.permissionDecisionHooks,
        insertionIndexes.permissionDecisionHooks,
        installed,
      );
    }
  }

  private trackLifecycleRegistration(
    installation: ManagedHookInstallation,
    disposer: void | (() => void),
  ): void {
    if (typeof disposer === "function") {
      installation.lifecycleDisposers.push(disposer);
    }
  }

  private uninstallManagedHooks(): ManagedHookInsertionIndexes | undefined {
    const installation = this.managedInstallation;
    if (installation === undefined) return undefined;
    this.managedInstallation = undefined;
    const insertionIndexes: ManagedHookInsertionIndexes = {
      preToolUseHooks: managedInsertionIndex(
        installation.target.preToolUseHooks,
        installation.preToolUseHooks,
        installation.insertionIndexes.preToolUseHooks,
      ),
      postToolUseHooks: managedInsertionIndex(
        installation.target.postToolUseHooks,
        installation.postToolUseHooks,
        installation.insertionIndexes.postToolUseHooks,
      ),
      failureToolUseHooks: managedInsertionIndex(
        installation.target.failureToolUseHooks,
        installation.failureToolUseHooks,
        installation.insertionIndexes.failureToolUseHooks,
      ),
      permissionDecisionHooks: managedInsertionIndex(
        installation.target.permissionDecisionHooks,
        installation.permissionDecisionHooks,
        installation.insertionIndexes.permissionDecisionHooks,
      ),
      userPromptSubmitHooks: managedInsertionIndex(
        installation.target.userPromptSubmitHooks,
        installation.userPromptSubmitHooks,
        installation.insertionIndexes.userPromptSubmitHooks,
      ),
      stopHooks: managedInsertionIndex(
        installation.target.stopHooks,
        installation.stopHooks,
        installation.insertionIndexes.stopHooks,
      ),
      stopFailureHooks: managedInsertionIndex(
        installation.target.stopFailureHooks,
        installation.stopFailureHooks,
        installation.insertionIndexes.stopFailureHooks,
      ),
    };
    removeInstalledHooks(
      installation.target.preToolUseHooks,
      installation.preToolUseHooks,
    );
    removeInstalledHooks(
      installation.target.postToolUseHooks,
      installation.postToolUseHooks,
    );
    removeInstalledHooks(
      installation.target.failureToolUseHooks,
      installation.failureToolUseHooks,
    );
    removeInstalledHooks(
      installation.target.permissionDecisionHooks,
      installation.permissionDecisionHooks,
    );
    removeInstalledHooks(
      installation.target.userPromptSubmitHooks,
      installation.userPromptSubmitHooks,
    );
    removeInstalledHooks(
      installation.target.stopHooks,
      installation.stopHooks,
    );
    removeInstalledHooks(
      installation.target.stopFailureHooks,
      installation.stopFailureHooks,
    );
    for (const dispose of installation.lifecycleDisposers.splice(0).reverse()) {
      dispose();
    }
    return insertionIndexes;
  }

  private createPreToolUseHook(hook: IndividualHookConfig): PreToolUseHook {
    return async ({ invocation, tool, args }) => {
      const toolName = tool.name;
      if (
        this.isExecutionSuppressed() ||
        !matchesToolMatcher(toolName, hook.matcher)
      ) {
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
        const reason = this.exitCodeTwoStderr(
          result,
          "PreToolUse",
          "a blocking reason",
        );
        return reason === undefined
          ? { kind: "continue" }
          : { kind: "deny", reason };
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
      if (unsupported !== null) {
        this.recordHookOutputIssue(result, unsupported);
        return { kind: "continue" };
      }
      if (specific?.permissionDecision === "deny") {
        const reason = trimmedReason(specific.permissionDecisionReason);
        if (reason !== undefined) {
          return { kind: "deny", reason: redactSecrets(reason) };
        }
      }
      return preToolUseContinueDecision(hook, specific);
    };
  }

  private createPostToolUseHook(hook: IndividualHookConfig): PostToolUseHook {
    return async ({ invocation, tool, args, result }) => {
      const toolName = tool.name;
      if (
        this.isExecutionSuppressed() ||
        !matchesToolMatcher(toolName, hook.matcher)
      ) {
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
        const feedback = this.exitCodeTwoStderr(run, "PostToolUse", "feedback");
        if (feedback === undefined) return { kind: "continue" };
        return {
          kind: "hook_blocking_error",
          blockingError: feedback,
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
        return {
          kind: "hook_blocking_error",
          blockingError: legacyBlockReason,
        };
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

  private createFailureHook(
    hook: IndividualHookConfig,
  ): PostToolUseFailureHook {
    return async ({ invocation, tool, args, error, isInterrupt }) => {
      const toolName = tool.name;
      if (
        this.isExecutionSuppressed() ||
        !matchesToolMatcher(toolName, hook.matcher)
      )
        return;
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
      if (this.isExecutionSuppressed()) {
        return { kind: "pass" };
      }
      const hookInput = {
        ...permissionDecisionHookInput(input, this.opts.cwd),
        hook_event_name: "PermissionRequest",
        tool_name: toolName,
        tool_input: args,
      };
      const handlers = this.engine.selectHandlersForMatcherInputs(
        "PermissionRequest",
        hookMatcherInputsForToolName(toolName, input.matcherAliases ?? []),
      );
      const runs = await Promise.all(
        handlers.map((hook) =>
          this.runCommandHook(hook, hookInput, input.signal),
        ),
      );
      let allow: PermissionDecisionResult | undefined;
      for (const run of runs) {
        if (run.status === "blocking") {
          const reason = trimmedReason(run.rawStderr);
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
    return async (input) => {
      const { prompt, permissionMode, cwd, signal } = input;
      if (this.isExecutionSuppressed()) {
        return undefined;
      }
      const run = await this.runCommandHook(
        hook,
        {
          session_id: input.sessionId ?? "",
          turn_id: input.turnId ?? "",
          transcript_path: input.transcriptPath ?? null,
          hook_event_name: "UserPromptSubmit",
          prompt,
          permission_mode: permissionMode ?? "default",
          cwd,
          model: input.model ?? "unknown",
        },
        signal,
      );
      if (run.status === "blocking") {
        const reason = this.exitCodeTwoStderr(
          run,
          "UserPromptSubmit",
          "a blocking reason",
        );
        if (reason === undefined) return undefined;
        return {
          blockingError: {
            blockingError: reason,
          },
        };
      }
      if (run.status !== "success") return undefined;
      const parsed = this.readStructuredOutput(run);
      const additionalContext = userPromptSubmitAdditionalContext(
        parsed,
        run.rawStdout,
      );
      const additionalContexts =
        additionalContext === undefined
          ? undefined
          : [redactSecrets(additionalContext)];
      const legacyBlockReason = legacyBlockReasonFor(
        parsed.output,
        "UserPromptSubmit",
        (message) => this.recordHookOutputIssue(run, message),
      );
      if (legacyBlockReason !== null) {
        return {
          blockingError: { blockingError: legacyBlockReason },
          ...(additionalContexts !== undefined ? { additionalContexts } : {}),
        };
      }
      if (parsed.output?.legacyDecision !== undefined) {
        return undefined;
      }
      if (parsed.output?.continueProcessing === false) {
        return {
          preventContinuation: true,
          ...(parsed.output.stopReason !== undefined
            ? { stopReason: redactSecrets(parsed.output.stopReason) }
            : {}),
          ...(additionalContexts !== undefined ? { additionalContexts } : {}),
        };
      }
      if (additionalContexts === undefined) return undefined;
      return {
        additionalContexts,
      };
    };
  }

  private createStopHook(hook: IndividualHookConfig): StopHookHandler {
    return {
      name: hookCommandLabel(hook),
      run: async (request) => {
        if (this.isExecutionSuppressed()) {
          return allowStopOutcome();
        }
        const run = await this.runCommandHook(hook, stopInput("Stop", request));
        if (run.status === "blocking") {
          const reason = this.exitCodeTwoStderr(
            run,
            "Stop",
            "a continuation prompt",
          );
          if (reason === undefined) return allowStopOutcome();
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
          if (parsed.output?.legacyDecision !== undefined) {
            return allowStopOutcome();
          }
          if (parsed.output?.continueProcessing === false) {
            return {
              shouldStop: true,
              ...(parsed.output.stopReason !== undefined
                ? { stopReason: redactSecrets(parsed.output.stopReason) }
                : {}),
              shouldBlock: false,
              continuationFragments: [],
            };
          }
          if (run.rawStdout.trim().length > 0 && parsed.output === undefined) {
            this.recordHookOutputIssue(
              run,
              "hook returned invalid stop hook JSON output",
            );
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
        if (
          this.isExecutionSuppressed() ||
          !matchesPattern(error, hook.matcher)
        ) {
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

  /**
   * Lifecycle-hook wrapper for events whose matcher key is not the
   * PreCompact/PostCompact `trigger` (SubagentStop matches
   * agent_type/task_name, SessionEnd matches reason, Notification
   * matches notification_type). Same run/parse semantics as
   * `createLifecycleHook`.
   */
  private createGenericLifecycleHook<I extends HookInput>(
    hook: IndividualHookConfig,
    matchKey: (input: I) => string,
  ): (input: I, signal?: AbortSignal) => Promise<HookResult> {
    return async (input, signal) => {
      if (
        this.isExecutionSuppressed() ||
        !matchesPattern(matchKey(input), hook.matcher)
      ) {
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

  private createLifecycleHook(
    hook: IndividualHookConfig,
  ): (
    input: PreCompactHookInput | PostCompactHookInput | SessionStartHookInput,
    signal?: AbortSignal,
  ) => Promise<HookResult> {
    if (hook.event === "SessionStart") {
      return this.createSessionStartHook(hook) as (
        input:
          PreCompactHookInput | PostCompactHookInput | SessionStartHookInput,
        signal?: AbortSignal,
      ) => Promise<HookResult>;
    }
    return async (input, signal) => {
      const matchQuery =
        input.hook_event_name === "SessionStart" ? input.source : input.trigger;
      if (
        this.isExecutionSuppressed() ||
        !matchesPattern(matchQuery, hook.matcher)
      ) {
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

  private createSessionStartHook(
    hook: IndividualHookConfig,
  ): (
    input: SessionStartHookInput,
    signal?: AbortSignal,
  ) => Promise<HookResult> {
    return async (input, signal) => {
      if (
        this.isExecutionSuppressed() ||
        !matchesPattern(input.source, hook.matcher)
      ) {
        return { succeeded: true, output: "", command: hook.command.command };
      }
      const run = await this.runCommandHook(
        hook,
        sessionStartInput(input, this.opts.cwd),
        signal,
      );
      const parsed =
        run.status === "success" ? this.readStructuredOutput(run) : undefined;
      const specific = parsed?.output;
      const additionalContexts = sessionStartAdditionalContexts(
        parsed,
        run.rawStdout,
      );
      if (
        run.status === "success" &&
        run.rawStdout.trim().length > 0 &&
        parsed?.output === undefined &&
        parsed?.explicit === true
      ) {
        this.recordHookOutputIssue(
          run,
          "hook returned invalid session start JSON output",
        );
      }
      if (run.status === "success" && specific?.continueProcessing === false) {
        const message = redactSecrets(
          specific.stopReason ?? "SessionStart hook stopped execution",
        );
        return {
          succeeded: false,
          output: message,
          command: hookCommandLabel(hook),
          message: {
            type: "hook_stopped_continuation",
            hookEvent: "SessionStart",
            hookName: hookCommandLabel(hook),
            message,
          },
          ...(additionalContexts.length > 0 ? { additionalContexts } : {}),
        };
      }
      if (run.status === "success") {
        return {
          succeeded: true,
          output: "",
          command: hookCommandLabel(hook),
          ...(additionalContexts.length > 0 ? { additionalContexts } : {}),
        };
      }
      return {
        succeeded: false,
        output: redactSecrets(run.rawStderr.trim() || run.rawStdout.trim()),
        command: hookCommandLabel(hook),
      };
    };
  }

  private async runCommandHook(
    hook: IndividualHookConfig,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HookCommandRunDiagnostic> {
    // Route mutable and immutable suppression through the engine so every
    // direct/test invocation records the same skipped diagnostic and never
    // reaches trust evaluation or the subprocess boundary.
    if (this.isExecutionSuppressed()) {
      return this.engine.runCommandHook(hook, input, signal, inputCwd(input));
    }
    if (!this.opts.executionAuthority.decision("command").allowed) {
      return skippedUntrustedDiagnostic(hook);
    }
    return this.engine.runCommandHook(hook, input, signal, inputCwd(input));
  }

  private recordHookOutputIssue(
    run: HookCommandRunDiagnostic,
    message: string,
  ): void {
    this.engine.recordHookOutputIssue(run, message);
  }

  private exitCodeTwoStderr(
    run: HookCommandRunDiagnostic,
    event: string,
    missingDescription: string,
  ): string | undefined {
    const reason = trimmedReason(run.rawStderr);
    if (reason === undefined) {
      this.recordHookOutputIssue(
        run,
        `${event} hook exited with code 2 but did not write ${missingDescription} to stderr`,
      );
      return undefined;
    }
    return redactSecrets(reason);
  }

  private readStructuredOutput(
    run: HookCommandRunDiagnostic,
  ): ReturnType<typeof readHookSpecificOutput> {
    const parsed = readHookSpecificOutput(run.rawStdout, run.event);
    if (parsed.invalid) {
      this.recordHookOutputIssue(run, parsed.invalid);
      return { explicit: parsed.explicit, invalid: parsed.invalid };
    }
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

/**
 * Synthetic "skipped" diagnostic returned when a config/plugin command hook is
 * NOT executed because the workspace is untrusted. Mirrors the shape the engine
 * produces for disabled hooks so downstream parsers treat it as a no-op (the
 * command is never spawned).
 */
function skippedUntrustedDiagnostic(
  hook: IndividualHookConfig,
): HookCommandRunDiagnostic {
  return {
    id: randomUUID(),
    event: hook.event,
    ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
    command: redactSecrets(hook.command.command),
    status: "skipped",
    durationMs: 0,
    stdout: "",
    stderr: "",
    error: "skipped: session hook policy denied command execution",
    startedAtUnixMs: Date.now(),
    rawStdout: "",
    rawStderr: "",
  };
}

function matchesToolMatcher(toolName: string, matcher?: string): boolean {
  return hookMatcherInputsForToolName(toolName).some((input) =>
    matchesPattern(input, matcher),
  );
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

function inputCwd(input: Record<string, unknown>): string | undefined {
  return stringValue(input.cwd);
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
    transcript_path: request.transcriptPath ?? null,
    cwd: request.cwd,
    model: request.model,
    permission_mode: request.permissionMode,
    stop_hook_active: request.stopHookActive,
    last_assistant_message: request.lastAssistantMessage ?? "",
  };
}

function sessionStartInput(
  input: SessionStartHookInput,
  fallbackCwd: string,
): Record<string, unknown> {
  return {
    hook_event_name: "SessionStart",
    session_id: input.session_id ?? "",
    transcript_path: input.transcript_path ?? null,
    cwd: input.cwd ?? fallbackCwd,
    model: input.model ?? "unknown",
    permission_mode: input.permission_mode ?? "default",
    source: input.source,
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
        tool_name: "FileRead",
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
      return {
        hook_event_name: event,
        session_id: "",
        transcript_path: null,
        source: "startup",
        cwd,
        model: "unknown",
        permission_mode: "default",
      };
    case "Stop":
    case "StopFailure":
      return { hook_event_name: event, cwd, error: "unknown" };
    case "PreCompact":
      return {
        hook_event_name: event,
        session_id: "",
        transcript_path: "",
        cwd,
        permission_mode: "default",
        trigger: "manual",
        custom_instructions: null,
      };
    case "PostCompact":
      return {
        hook_event_name: event,
        session_id: "",
        transcript_path: "",
        cwd,
        permission_mode: "default",
        trigger: "manual",
        compact_summary: "",
      };
    case "SubagentStop":
      return {
        hook_event_name: event,
        task_name: "test",
        agent_id: "test",
        outcome: "completed",
        final_message: "",
      };
    case "SessionEnd":
      return { hook_event_name: event, reason: "exit", cwd };
    case "Notification":
      return {
        hook_event_name: event,
        message: "test",
        notification_type: "permission_request",
      };
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() || "Hook blocked.";
}

function userPromptSubmitAdditionalContext(
  parsed: ReturnType<typeof readHookSpecificOutput>,
  stdout: string,
): string | undefined {
  if (parsed.invalid !== undefined) return undefined;
  if (parsed.explicit) return parsed.output?.additionalContext;
  return trimmedReason(stdout);
}

function sessionStartAdditionalContexts(
  parsed: ReturnType<typeof readHookSpecificOutput> | undefined,
  stdout: string,
): readonly string[] {
  if (parsed === undefined || parsed.invalid !== undefined) return [];
  const context = parsed.explicit
    ? parsed.output?.additionalContext
    : trimmedReason(stdout);
  return context === undefined ? [] : [redactSecrets(context)];
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
      recordIssue(
        `${event} hook returned decision:block without a non-empty reason`,
      );
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
  if (
    output?.permissionDecision === "deny" &&
    trimmedReason(output.permissionDecisionReason) === undefined
  ) {
    return "PreToolUse hook returned permissionDecision:deny without a non-empty permissionDecisionReason";
  }
  if (
    output?.permissionDecision === undefined &&
    output?.permissionDecisionReason !== undefined
  ) {
    return "PreToolUse hook returned permissionDecisionReason without permissionDecision";
  }
  return null;
}

function preToolUseContinueDecision(
  hook: IndividualHookConfig,
  output: HookSpecificOutput | undefined,
): PreToolUseDecision {
  const args = output?.updatedInput;
  const additionalContext = trimmedReason(output?.additionalContext);
  const permissionBehavior = output?.permissionDecision;
  const permissionReason = trimmedReason(output?.permissionDecisionReason);
  const hookPermissionResult =
    permissionBehavior === "allow" || permissionBehavior === "ask"
      ? preToolUseHookPermissionResult(
          hook,
          permissionBehavior,
          permissionReason,
          args,
        )
      : undefined;
  return {
    kind: "continue",
    ...(args !== undefined ? { args } : {}),
    ...(hookPermissionResult !== undefined ? { hookPermissionResult } : {}),
    ...(additionalContext !== undefined
      ? { additionalContext: [redactSecrets(additionalContext)] }
      : {}),
  };
}

function preToolUseHookPermissionResult(
  hook: IndividualHookConfig,
  behavior: "allow" | "ask",
  reason: string | undefined,
  updatedInput: Record<string, unknown> | undefined,
): HookPermissionResult {
  return {
    behavior,
    hookName: hookCommandLabel(hook),
    ...(reason !== undefined ? { message: redactSecrets(reason) } : {}),
    ...(updatedInput !== undefined ? { updatedInput } : {}),
  };
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
