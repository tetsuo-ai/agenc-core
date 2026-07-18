/**
 * Hook engine shared shapes.
 *
 * Shared shapes for AgenC's configured-hook runtime.
 */

import type { HookCommand, HookEventName } from "../../config/schema.js";
import type { SandboxExecutionBrokerLike } from "../../sandbox/execution-broker.js";
import type { ExecutionAdmissionClient } from "../../budget/admission-client.js";

export type HookRunStatus =
  "success" | "blocking" | "non_blocking_error" | "timeout" | "skipped";

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

export interface CommandRunResult {
  readonly status: HookRunStatus;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly error?: string;
}

export interface HookCommandRunDiagnostic extends HookRunDiagnostic {
  readonly rawStdout: string;
  readonly rawStderr: string;
  readonly rawError?: string;
}

export interface HookEngineOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shellPath: string;
  readonly sourcePath: string;
  readonly maxDiagnostics?: number;
  readonly sandboxExecutionBroker?: SandboxExecutionBrokerLike;
  readonly executionAdmission?: ExecutionAdmissionClient;
  readonly admissionRequired?: boolean;
}

export interface HookDispatchResult {
  readonly hook: IndividualHookConfig;
  readonly run: HookCommandRunDiagnostic;
}
