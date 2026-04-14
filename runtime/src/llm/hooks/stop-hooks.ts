import { spawn } from "node:child_process";

import type { ToolHandler } from "../types.js";
import type { ToolCallRecord } from "../chat-executor-types.js";
import type { DelegationContractSpec } from "../../utils/delegation-validation.js";
import type { ExecutionEnvelope } from "../../workflow/execution-envelope.js";
import type { ImplementationCompletionContract } from "../../workflow/completion-contract.js";
import type { WorkflowVerificationContract } from "../../workflow/verification-obligations.js";
import {
  buildTurnEndStopGateSnapshot,
  checkFilesystemArtifacts,
  evaluateTurnEndStopGate,
  evaluateArtifactEvidenceGate,
  type TurnEndStopGateSnapshot,
} from "../chat-executor-stop-gate.js";
import { runDeterministicAcceptanceProbes } from "../deterministic-acceptance-probes.js";
import { matchesHookMatcher } from "./matcher.js";

export const STOP_HOOK_PHASES = [
  "Stop",
  "TaskCompleted",
  "WorkerIdle",
  "VerificationReady",
] as const;

export type StopHookPhase = (typeof STOP_HOOK_PHASES)[number];

export const STOP_HOOK_CONFIG_KINDS = ["command", "http"] as const;
export type StopHookConfigKind = (typeof STOP_HOOK_CONFIG_KINDS)[number];

export const STOP_HOOK_DEFAULT_TIMEOUT_MS = 5_000;
export const STOP_HOOK_RESERVED_ID_PREFIX = "builtin:";
export const BUILTIN_TURN_END_STOP_GATE_ID = `${STOP_HOOK_RESERVED_ID_PREFIX}turn_end_stop_gate`;
export const BUILTIN_ARTIFACT_EVIDENCE_HOOK_ID =
  `${STOP_HOOK_RESERVED_ID_PREFIX}artifact_evidence`;
export const BUILTIN_FILESYSTEM_ARTIFACT_VERIFICATION_HOOK_ID =
  `${STOP_HOOK_RESERVED_ID_PREFIX}filesystem_artifact_verification`;
export const BUILTIN_DETERMINISTIC_ACCEPTANCE_PROBES_HOOK_ID =
  `${STOP_HOOK_RESERVED_ID_PREFIX}deterministic_acceptance_probes`;
export const BUILTIN_STOP_HOOK_IDS = [
  BUILTIN_TURN_END_STOP_GATE_ID,
  BUILTIN_ARTIFACT_EVIDENCE_HOOK_ID,
  BUILTIN_FILESYSTEM_ARTIFACT_VERIFICATION_HOOK_ID,
  BUILTIN_DETERMINISTIC_ACCEPTANCE_PROBES_HOOK_ID,
] as const;

export interface StopHookHandlerConfig {
  readonly id: string;
  readonly phase: StopHookPhase;
  readonly kind: StopHookConfigKind;
  readonly matcher?: string;
  readonly target: string;
  readonly timeoutMs?: number;
}

export interface StopHookRuntimeConfig {
  readonly enabled?: boolean;
  readonly maxAttempts?: number;
  readonly handlers?: readonly StopHookHandlerConfig[];
}

export interface StopHookTaskPayload {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly status: string;
  readonly activeForm?: string;
  readonly owner?: string;
  readonly blocks: readonly string[];
  readonly blockedBy: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StopHookContext {
  readonly phase: StopHookPhase;
  readonly sessionId: string;
  readonly runtimeWorkspaceRoot?: string;
  readonly finalContent?: string;
  readonly allToolCalls?: readonly ToolCallRecord[];
  readonly turnEndSnapshot?: TurnEndStopGateSnapshot;
  readonly runtimeChecks?: {
    readonly requiredToolEvidence?: {
      readonly maxCorrectionAttempts?: number;
      readonly delegationSpec?: DelegationContractSpec;
      readonly unsafeBenchmarkMode?: boolean;
      readonly verificationContract?: WorkflowVerificationContract;
      readonly completionContract?: ImplementationCompletionContract;
      readonly executionEnvelope?: ExecutionEnvelope;
    };
    readonly targetArtifacts?: readonly string[];
    readonly activeToolHandler?: ToolHandler;
    readonly appendProbeRuns?: (runs: readonly ToolCallRecord[]) => void;
  };
  readonly verificationReady?: {
    readonly deterministicAcceptanceProbesEnabled: boolean;
    readonly topLevelVerifierEnabled: boolean;
    readonly targetArtifacts?: readonly string[];
  };
  readonly taskCompleted?: {
    readonly listId: string;
    readonly taskId: string;
    readonly task: StopHookTaskPayload;
    readonly patch: Record<string, unknown>;
  };
  readonly workerIdle?: {
    readonly runId: string;
    readonly objective: string;
    readonly pendingSignals: number;
    readonly nextCheckMs: number;
    readonly idleHookBlockStreak: number;
  };
}

export interface StopHookProgressMessage {
  readonly hookId: string;
  readonly message: string;
}

export interface StopHookBlockingError {
  readonly hookId: string;
  readonly message: string;
  readonly evidence?: unknown;
}

export interface StopHookOutcome {
  readonly hookId: string;
  readonly phase: StopHookPhase;
  readonly progressMessages: readonly StopHookProgressMessage[];
  readonly blockingError?: StopHookBlockingError;
  readonly preventContinuation?: boolean;
  readonly stopReason?: string;
  readonly evidence?: unknown;
  readonly durationMs: number;
}

export interface StopHookPhaseResult {
  readonly phase: StopHookPhase;
  readonly outcome: "pass" | "retry_with_blocking_message" | "prevent_continuation";
  readonly reason?: string;
  readonly stopReason?: string;
  readonly blockingMessage?: string;
  readonly evidence?: unknown;
  readonly progressMessages: readonly StopHookProgressMessage[];
  readonly hookOutcomes: readonly StopHookOutcome[];
}

interface StopHookRuntimeDefinition {
  readonly id: string;
  readonly phase: StopHookPhase;
  readonly kind: StopHookConfigKind | "builtin";
  readonly matcher?: string;
  readonly target: string;
  readonly timeoutMs?: number;
  readonly source: "builtin" | "config";
  readonly builtinHandler?: (context: StopHookContext) => Promise<StopHookOutcome>;
}

export interface StopHookRuntime {
  readonly maxAttempts: number;
  readonly maxAttemptsExplicit: boolean;
  readonly definitionsByPhase: ReadonlyMap<StopHookPhase, readonly StopHookRuntimeDefinition[]>;
}

function buildBuiltinStopHookDefinitions(): readonly StopHookRuntimeDefinition[] {
  return [
    {
      id: BUILTIN_TURN_END_STOP_GATE_ID,
      phase: "Stop",
      kind: "builtin",
      target: "evaluateTurnEndStopGate",
      source: "builtin",
      builtinHandler: async (context) => {
        const startedAt = Date.now();
        const decision = evaluateTurnEndStopGate({
          finalContent: context.finalContent ?? "",
          allToolCalls: context.allToolCalls,
          snapshot:
            context.turnEndSnapshot ??
            buildTurnEndStopGateSnapshot(context.allToolCalls ?? []),
        });
        return {
          hookId: BUILTIN_TURN_END_STOP_GATE_ID,
          phase: context.phase,
          progressMessages: [],
          ...(decision.shouldIntervene
            ? {
                blockingError: {
                  hookId: BUILTIN_TURN_END_STOP_GATE_ID,
                  message:
                    decision.blockingMessage ??
                    "Runtime stop hook blocked continuation.",
                  evidence: decision.evidence,
                },
                stopReason: decision.reason,
                evidence: decision.evidence,
              }
            : {}),
          durationMs: Date.now() - startedAt,
        };
      },
    },
    {
      id: BUILTIN_ARTIFACT_EVIDENCE_HOOK_ID,
      phase: "Stop",
      kind: "builtin",
      target: "evaluateArtifactEvidenceGate",
      source: "builtin",
      builtinHandler: async (context) => {
        const startedAt = Date.now();
        const decision = evaluateArtifactEvidenceGate({
          requiredToolEvidence: context.runtimeChecks?.requiredToolEvidence,
          runtimeContext: {
            workspaceRoot: context.runtimeWorkspaceRoot,
          },
          allToolCalls: context.allToolCalls ?? [],
        });
        return {
          hookId: BUILTIN_ARTIFACT_EVIDENCE_HOOK_ID,
          phase: context.phase,
          progressMessages: [],
          ...(decision.shouldIntervene
            ? {
                blockingError: {
                  hookId: BUILTIN_ARTIFACT_EVIDENCE_HOOK_ID,
                  message:
                    decision.blockingMessage ??
                    "Artifact evidence is incomplete.",
                  evidence: decision.evidence,
                },
                stopReason: decision.validationCode,
                evidence: decision.evidence,
              }
            : { evidence: decision.evidence }),
          durationMs: Date.now() - startedAt,
        };
      },
    },
    {
      id: BUILTIN_FILESYSTEM_ARTIFACT_VERIFICATION_HOOK_ID,
      phase: "Stop",
      kind: "builtin",
      target: "checkFilesystemArtifacts",
      source: "builtin",
      builtinHandler: async (context) => {
        const startedAt = Date.now();
        const check = await checkFilesystemArtifacts({
          finalContent: context.finalContent ?? "",
          allToolCalls: context.allToolCalls ?? [],
        });
        return {
          hookId: BUILTIN_FILESYSTEM_ARTIFACT_VERIFICATION_HOOK_ID,
          phase: context.phase,
          progressMessages: [],
          ...(check.shouldIntervene
            ? {
                blockingError: {
                  hookId: BUILTIN_FILESYSTEM_ARTIFACT_VERIFICATION_HOOK_ID,
                  message:
                    check.blockingMessage ??
                    "Filesystem artifact verification failed.",
                  evidence: {
                    emptyFiles: check.emptyFiles,
                    missingFiles: check.missingFiles,
                    checkedFiles: check.checkedFiles,
                  },
                },
                stopReason: "filesystem_artifact_verification",
                evidence: {
                  emptyFiles: check.emptyFiles,
                  missingFiles: check.missingFiles,
                  checkedFiles: check.checkedFiles,
                },
              }
            : {
                evidence: {
                  emptyFiles: check.emptyFiles,
                  missingFiles: check.missingFiles,
                  checkedFiles: check.checkedFiles,
                },
              }),
          durationMs: Date.now() - startedAt,
        };
      },
    },
    {
      id: BUILTIN_DETERMINISTIC_ACCEPTANCE_PROBES_HOOK_ID,
      phase: "Stop",
      kind: "builtin",
      target: "runDeterministicAcceptanceProbes",
      source: "builtin",
      builtinHandler: async (context) => {
        const startedAt = Date.now();
        const activeToolHandler = context.runtimeChecks?.activeToolHandler;
        if (!activeToolHandler) {
          return passOutcome(
            BUILTIN_DETERMINISTIC_ACCEPTANCE_PROBES_HOOK_ID,
            context.phase,
            Date.now() - startedAt,
          );
        }
        const decision = await runDeterministicAcceptanceProbes({
          workspaceRoot: context.runtimeWorkspaceRoot,
          targetArtifacts: context.runtimeChecks?.targetArtifacts,
          allToolCalls: context.allToolCalls ?? [],
          activeToolHandler,
        });
        if (decision.probeRuns.length > 0) {
          context.runtimeChecks?.appendProbeRuns?.(decision.probeRuns);
        }
        if (!decision.shouldIntervene) {
          return {
            hookId: BUILTIN_DETERMINISTIC_ACCEPTANCE_PROBES_HOOK_ID,
            phase: context.phase,
            progressMessages: [],
            evidence: {
              evidence: decision.evidence,
              probeRuns: decision.probeRuns,
            },
            durationMs: Date.now() - startedAt,
          };
        }
        if (decision.allowRecovery === false) {
          return {
            hookId: BUILTIN_DETERMINISTIC_ACCEPTANCE_PROBES_HOOK_ID,
            phase: context.phase,
            progressMessages: [],
            preventContinuation: true,
            stopReason:
              decision.validationCode ??
              "deterministic_acceptance_probe_failed",
            evidence: {
              evidence: decision.evidence,
              probeRuns: decision.probeRuns,
            },
            durationMs: Date.now() - startedAt,
          };
        }
        return {
          hookId: BUILTIN_DETERMINISTIC_ACCEPTANCE_PROBES_HOOK_ID,
          phase: context.phase,
          progressMessages: [],
          blockingError: {
            hookId: BUILTIN_DETERMINISTIC_ACCEPTANCE_PROBES_HOOK_ID,
            message:
              decision.blockingMessage ??
              "Deterministic acceptance probes failed.",
            evidence: {
              evidence: decision.evidence,
              probeRuns: decision.probeRuns,
            },
          },
          stopReason:
            decision.validationCode ??
            "deterministic_acceptance_probe_failed",
          evidence: {
            evidence: decision.evidence,
            probeRuns: decision.probeRuns,
          },
          durationMs: Date.now() - startedAt,
        };
      },
    },
  ];
}

export function buildStopHookRuntime(
  config: StopHookRuntimeConfig | undefined,
): StopHookRuntime | undefined {
  if (config?.enabled === false) {
    return undefined;
  }
  const definitionsByPhase = new Map<StopHookPhase, StopHookRuntimeDefinition[]>();
  for (const definition of buildBuiltinStopHookDefinitions()) {
    const list = definitionsByPhase.get(definition.phase) ?? [];
    list.push(definition);
    definitionsByPhase.set(definition.phase, list);
  }
  for (const handler of config?.handlers ?? []) {
    const list = definitionsByPhase.get(handler.phase) ?? [];
    list.push({
      ...handler,
      source: "config",
    });
    definitionsByPhase.set(handler.phase, list);
  }
  return {
    maxAttempts: normalizeMaxAttempts(config?.maxAttempts),
    maxAttemptsExplicit: config?.maxAttempts !== undefined,
    definitionsByPhase,
  };
}

export function hasStopHookHandlers(
  runtime: StopHookRuntime | undefined,
  phase: StopHookPhase,
): boolean {
  return (runtime?.definitionsByPhase.get(phase)?.length ?? 0) > 0;
}

export async function runStopHookPhase(params: {
  readonly runtime: StopHookRuntime | undefined;
  readonly phase: StopHookPhase;
  readonly context: StopHookContext;
  readonly matchKey?: string;
}): Promise<StopHookPhaseResult> {
  const definitions = params.runtime?.definitionsByPhase.get(params.phase) ?? [];
  const matched = definitions.filter((definition) =>
    matchesHookMatcher(definition.matcher, params.matchKey ?? ""),
  );
  if (matched.length === 0) {
    return {
      phase: params.phase,
      outcome: "pass",
      progressMessages: [],
      hookOutcomes: [],
    };
  }

  const outcomes: StopHookOutcome[] = [];
  for (const definition of matched) {
    const outcome = await runStopHookDefinition(definition, params.context);
    outcomes.push(outcome);
    const progressMessages = outcomes.flatMap(
      (candidate) => candidate.progressMessages,
    );
    if (outcome.preventContinuation) {
      return {
        phase: params.phase,
        outcome: "prevent_continuation",
        reason: outcome.hookId,
        stopReason:
          outcome.stopReason ??
          outcome.blockingError?.message ??
          "Runtime stop hook prevented continuation.",
        evidence: mergeStopHookEvidence(outcomes),
        progressMessages,
        hookOutcomes: outcomes,
      };
    }
    if (outcome.blockingError) {
      return {
        phase: params.phase,
        outcome: "retry_with_blocking_message",
        reason: outcome.stopReason ?? outcome.hookId,
        blockingMessage: outcome.blockingError.message,
        evidence: mergeStopHookEvidence(outcomes),
        progressMessages,
        hookOutcomes: outcomes,
      };
    }
  }
  const progressMessages = outcomes.flatMap((outcome) => outcome.progressMessages);
  return {
    phase: params.phase,
    outcome: "pass",
    evidence: mergeStopHookEvidence(outcomes),
    progressMessages,
    hookOutcomes: outcomes,
  };
}

function normalizeMaxAttempts(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.floor(value ?? 1));
}

async function runStopHookDefinition(
  definition: StopHookRuntimeDefinition,
  context: StopHookContext,
): Promise<StopHookOutcome> {
  switch (definition.kind) {
    case "builtin":
      return definition.builtinHandler
        ? definition.builtinHandler(context)
        : passOutcome(definition.id, context.phase, 0);
    case "command":
      return runStopHookWithTimeout(
        definition,
        context,
        runStopCommandHook(definition, context),
      );
    case "http":
      return runStopHookWithTimeout(
        definition,
        context,
        runStopHttpHook(definition, context),
      );
    default:
      return passOutcome(definition.id, context.phase, 0);
  }
}

async function runStopHookWithTimeout(
  definition: StopHookRuntimeDefinition,
  context: StopHookContext,
  promise: Promise<StopHookOutcome>,
): Promise<StopHookOutcome> {
  const timeoutMs = Math.max(
    1,
    Math.floor(definition.timeoutMs ?? STOP_HOOK_DEFAULT_TIMEOUT_MS),
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<StopHookOutcome>((resolve) => {
        timer = setTimeout(() => {
          resolve({
            hookId: definition.id,
            phase: context.phase,
            progressMessages: [],
            blockingError: {
              hookId: definition.id,
              message: `Stop hook "${definition.id}" timed out after ${timeoutMs}ms.`,
            },
            durationMs: timeoutMs,
          });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function runStopCommandHook(
  definition: StopHookRuntimeDefinition,
  context: StopHookContext,
): Promise<StopHookOutcome> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("/bin/sh", ["-c", definition.target], {
      env: {
        ...process.env,
        AGENC_STOP_HOOK_ID: definition.id,
        AGENC_STOP_HOOK_PHASE: context.phase,
        AGENC_STOP_HOOK_SESSION_ID: context.sessionId,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        hookId: definition.id,
        phase: context.phase,
        progressMessages: [],
        blockingError: {
          hookId: definition.id,
          message: `Stop hook "${definition.id}" failed to start: ${error.message}`,
        },
        durationMs: Date.now() - startedAt,
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(context));
    child.on("close", (code) => {
      resolve(
        normalizeStopHookProcessResult({
          hookId: definition.id,
          phase: context.phase,
          exitCode: code,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
        }),
      );
    });
  });
}

async function runStopHttpHook(
  definition: StopHookRuntimeDefinition,
  context: StopHookContext,
): Promise<StopHookOutcome> {
  const startedAt = Date.now();
  try {
    const response = await fetch(definition.target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agenc-stop-hook-id": definition.id,
        "x-agenc-stop-hook-phase": context.phase,
      },
      body: JSON.stringify(context),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      return {
        hookId: definition.id,
        phase: context.phase,
        progressMessages: [],
        blockingError: {
          hookId: definition.id,
          message:
            bodyText.trim().length > 0
              ? bodyText.trim()
              : `Stop hook "${definition.id}" returned HTTP ${response.status}.`,
        },
        durationMs: Date.now() - startedAt,
      };
    }
    return normalizeStopHookSuccessPayload({
      hookId: definition.id,
      phase: context.phase,
      text: bodyText,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    return {
      hookId: definition.id,
      phase: context.phase,
      progressMessages: [],
      blockingError: {
        hookId: definition.id,
        message:
          error instanceof Error
            ? `Stop hook "${definition.id}" HTTP request failed: ${error.message}`
            : `Stop hook "${definition.id}" HTTP request failed.`,
      },
      durationMs: Date.now() - startedAt,
    };
  }
}

function normalizeStopHookProcessResult(params: {
  readonly hookId: string;
  readonly phase: StopHookPhase;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}): StopHookOutcome {
  if (params.exitCode === 0) {
    return normalizeStopHookSuccessPayload({
      hookId: params.hookId,
      phase: params.phase,
      text: params.stdout,
      durationMs: params.durationMs,
    });
  }
  const blockingMessage =
    params.stderr.trim() || params.stdout.trim() ||
    `Stop hook "${params.hookId}" exited with code ${params.exitCode ?? "unknown"}.`;
  return {
    hookId: params.hookId,
    phase: params.phase,
    progressMessages: [],
    blockingError: {
      hookId: params.hookId,
      message: blockingMessage,
    },
    durationMs: params.durationMs,
  };
}

function normalizeStopHookSuccessPayload(params: {
  readonly hookId: string;
  readonly phase: StopHookPhase;
  readonly text: string;
  readonly durationMs: number;
}): StopHookOutcome {
  const trimmed = params.text.trim();
  if (trimmed.length === 0) {
    return passOutcome(params.hookId, params.phase, params.durationMs);
  }
  const parsed = parseStopHookJson(trimmed);
  if (!parsed) {
    return {
      hookId: params.hookId,
      phase: params.phase,
      progressMessages: [{ hookId: params.hookId, message: trimmed }],
      durationMs: params.durationMs,
    };
  }
  const progressMessages = normalizeProgressMessages(
    params.hookId,
    parsed.progressMessages ?? parsed.progressMessage,
  );
  const blockingError = normalizeBlockingError(
    params.hookId,
    parsed.blockingError,
    parsed.evidence,
  );
  const preventContinuation = parsed.preventContinuation === true;
  return {
    hookId: params.hookId,
    phase: params.phase,
    progressMessages,
    ...(blockingError ? { blockingError } : {}),
    ...(preventContinuation ? { preventContinuation: true } : {}),
    ...(typeof parsed.stopReason === "string" && parsed.stopReason.trim().length > 0
      ? { stopReason: parsed.stopReason.trim() }
      : {}),
    ...(parsed.evidence !== undefined ? { evidence: parsed.evidence } : {}),
    durationMs: params.durationMs,
  };
}

function passOutcome(
  hookId: string,
  phase: StopHookPhase,
  durationMs: number,
): StopHookOutcome {
  return {
    hookId,
    phase,
    progressMessages: [],
    durationMs,
  };
}

function parseStopHookJson(
  text: string,
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Plain-text output is treated as a progress message.
  }
  return undefined;
}

function normalizeProgressMessages(
  hookId: string,
  value: unknown,
): readonly StopHookProgressMessage[] {
  if (typeof value === "string" && value.trim().length > 0) {
    return [{ hookId, message: value.trim() }];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .flatMap((entry) => {
      if (typeof entry === "string" && entry.trim().length > 0) {
        return [{ hookId, message: entry.trim() }];
      }
      if (
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof (entry as { message?: unknown }).message === "string" &&
        (entry as { message: string }).message.trim().length > 0
      ) {
        return [{ hookId, message: (entry as { message: string }).message.trim() }];
      }
      return [];
    });
}

function normalizeBlockingError(
  hookId: string,
  value: unknown,
  fallbackEvidence: unknown,
): StopHookBlockingError | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return {
      hookId,
      message: value.trim(),
      ...(fallbackEvidence !== undefined ? { evidence: fallbackEvidence } : {}),
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const message =
    typeof (value as { message?: unknown }).message === "string"
      ? (value as { message: string }).message.trim()
      : "";
  if (message.length === 0) {
    return undefined;
  }
  const evidence =
    (value as { evidence?: unknown }).evidence !== undefined
      ? (value as { evidence: unknown }).evidence
      : fallbackEvidence;
  return {
    hookId,
    message,
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

function mergeStopHookEvidence(
  outcomes: readonly StopHookOutcome[],
): unknown {
  const entries = outcomes.flatMap((outcome) => {
    const evidence = outcome.blockingError?.evidence ?? outcome.evidence;
    return evidence === undefined ? [] : [[outcome.hookId, evidence] as const];
  });
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1 && outcomes.length === 1) {
    return entries[0][1];
  }
  return Object.fromEntries(entries);
}
