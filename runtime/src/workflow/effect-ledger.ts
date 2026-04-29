import type { ApprovalResponse } from "../gateway/approvals.js";
import type { ToolHandler } from "../llm/types.js";
import type {
  EffectCompensationState,
  EffectFilesystemSnapshot,
  EffectRecord,
  EffectRecordInput,
  EffectStatus,
  EffectResultSummary,
} from "./effects.js";
import {
  appendEffectAttempt,
  createInitialEffectRecord,
  summarizeToolResult,
} from "./effects.js";
import type { EffectStorage } from "./effect-storage.js";
import { MemoryBackendEffectStorage } from "./effect-storage.js";
import type { MemoryBackend } from "../memory/types.js";
import { executeCompensation } from "./compensation.js";

export class EffectLedger {
  constructor(
    private readonly storage: EffectStorage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  static fromMemoryBackend(
    backend: MemoryBackend,
    ttlMs?: number,
  ): EffectLedger {
    return new EffectLedger(new MemoryBackendEffectStorage(backend, ttlMs));
  }

  async beginEffect(input: EffectRecordInput): Promise<EffectRecord> {
    const existing = await this.storage.getByIdempotencyKey(input.idempotencyKey);
    if (!existing) {
      const created = createInitialEffectRecord(input);
      await this.storage.save(created);
      return created;
    }

    const nextStatus: EffectStatus = input.requiresApproval
      ? "pending_approval"
      : "intent_recorded";
    const updated = appendEffectAttempt(existing, input.createdAt, nextStatus);
    const merged: EffectRecord = {
      ...updated,
      toolCallId: input.toolCallId,
      args: structuredClone(input.args),
      scope: structuredClone(input.scope),
      kind: input.kind,
      effectClass: input.effectClass,
      intentSummary: input.intentSummary,
      targets: structuredClone(input.targets),
      ...(input.preExecutionSnapshots && input.preExecutionSnapshots.length > 0
        ? { preExecutionSnapshots: structuredClone(input.preExecutionSnapshots) }
        : {}),
      result: undefined,
      postExecutionSnapshots: undefined,
      approval: undefined,
      compensation: { status: "not_available", actions: [] },
      updatedAt: input.createdAt,
      ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}),
    };
    await this.storage.save(merged);
    return merged;
  }

  async recordApprovalRequested(params: {
    readonly effectId: string;
    readonly requestId: string;
  }): Promise<EffectRecord | undefined> {
    return this.mutate(params.effectId, (record) => ({
      ...record,
      status: "pending_approval",
      updatedAt: this.now(),
      approval: {
        ...(record.approval ?? {}),
        requestId: params.requestId,
        requestedAt: this.now(),
      },
      attempts: record.attempts.map((attempt, index) =>
        index === record.attempts.length - 1
          ? { ...attempt, status: "pending_approval" }
          : attempt,
      ),
    }));
  }

  async recordApprovalResolved(params: {
    readonly effectId: string;
    readonly response: ApprovalResponse;
  }): Promise<EffectRecord | undefined> {
    return this.mutate(params.effectId, (record) => {
      const approved = params.response.disposition !== "no";
      const resolver = params.response.resolver;
      const approval = {
        ...(record.approval ?? {}),
        disposition: params.response.disposition,
        resolvedAt: resolver?.resolvedAt ?? this.now(),
        approvedBy: params.response.approvedBy,
        resolverSessionId: resolver?.sessionId,
        resolverRoles: resolver?.roles,
      };
      return {
        ...record,
        status: approved ? "approved" : "denied",
        updatedAt: this.now(),
        approval,
        attempts: record.attempts.map((attempt, index) =>
          index === record.attempts.length - 1
            ? {
                ...attempt,
                status: approved ? "approved" : "denied",
                completedAt: approved ? attempt.completedAt : this.now(),
                ...(approved
                  ? {}
                  : { error: "Effect denied by approval policy." }),
              }
            : attempt,
        ),
      };
    });
  }

  async markDenied(params: {
    readonly effectId: string;
    readonly reason: string;
  }): Promise<EffectRecord | undefined> {
    return this.mutate(params.effectId, (record) => ({
      ...record,
      status: "denied",
      updatedAt: this.now(),
      attempts: record.attempts.map((attempt, index) =>
        index === record.attempts.length - 1
          ? {
              ...attempt,
              status: "denied",
              completedAt: this.now(),
              error: params.reason,
            }
          : attempt,
      ),
    }));
  }

  async markExecuting(effectId: string): Promise<EffectRecord | undefined> {
    return this.mutate(effectId, (record) => ({
      ...record,
      status: "executing",
      updatedAt: this.now(),
      attempts: record.attempts.map((attempt, index) =>
        index === record.attempts.length - 1
          ? {
              ...attempt,
              status: "executing",
              startedAt: attempt.startedAt ?? this.now(),
            }
          : attempt,
      ),
    }));
  }

  async recordOutcome(params: {
    readonly effectId: string;
    readonly success: boolean;
    readonly isError: boolean;
    readonly durationMs?: number;
    readonly result: string;
    readonly error?: string;
    readonly postExecutionSnapshots?: readonly EffectFilesystemSnapshot[];
    readonly compensation?: EffectCompensationState;
    readonly observedMutationsUnknown?: boolean;
  }): Promise<EffectRecord | undefined> {
    return this.mutate(params.effectId, (record) => {
      const completedAt = this.now();
      const status: EffectStatus = params.success ? "succeeded" : "failed";
      const resultSummary: EffectResultSummary = {
        success: params.success,
        isError: params.isError,
        completedAt,
        ...(params.durationMs !== undefined
          ? { durationMs: params.durationMs }
          : {}),
        resultSnippet: summarizeToolResult(params.result),
        ...(params.observedMutationsUnknown
          ? { observedMutationsUnknown: true }
          : {}),
        ...(params.error ? { error: params.error } : {}),
      };
      return {
        ...record,
        status,
        updatedAt: completedAt,
        result: resultSummary,
        ...(params.postExecutionSnapshots
          ? {
              postExecutionSnapshots: structuredClone(
                params.postExecutionSnapshots,
              ),
            }
          : {}),
        compensation: params.compensation ?? record.compensation,
        attempts: record.attempts.map((attempt, index) =>
          index === record.attempts.length - 1
            ? {
                ...attempt,
                status,
                completedAt,
                ...(params.durationMs !== undefined
                  ? { durationMs: params.durationMs }
                  : {}),
                resultSnippet: summarizeToolResult(params.result),
                ...(params.error ? { error: params.error } : {}),
              }
            : attempt,
        ),
      };
    });
  }

  async compensateEffect(params: {
    readonly effectId: string;
    readonly toolHandler?: ToolHandler;
  }): Promise<EffectRecord | undefined> {
    const record = await this.storage.get(params.effectId);
    if (!record) {
      return undefined;
    }
    const result = await executeCompensation({
      record,
      toolHandler: params.toolHandler,
    });
    return this.mutate(params.effectId, (current) => ({
      ...current,
      status: result.status === "completed" ? "compensated" : "compensation_failed",
      updatedAt: this.now(),
      compensation: {
        ...current.compensation,
        status: result.status === "completed" ? "completed" : "failed",
        lastAttemptAt: this.now(),
        ...(result.error ? { lastError: result.error } : {}),
      },
    }));
  }

  async getEffect(effectId: string): Promise<EffectRecord | undefined> {
    return this.storage.get(effectId);
  }

  async getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<EffectRecord | undefined> {
    return this.storage.getByIdempotencyKey(idempotencyKey);
  }

  async listSessionEffects(
    sessionId: string,
    limit?: number,
  ): Promise<readonly EffectRecord[]> {
    return this.storage.listBySession(sessionId, limit);
  }

  async listRunEffects(
    runId: string,
    limit?: number,
  ): Promise<readonly EffectRecord[]> {
    return this.storage.listByRun(runId, limit);
  }

  async listPipelineEffects(
    pipelineId: string,
    limit?: number,
  ): Promise<readonly EffectRecord[]> {
    return this.storage.listByPipeline(pipelineId, limit);
  }

  private async mutate(
    effectId: string,
    mutate: (record: EffectRecord) => EffectRecord,
  ): Promise<EffectRecord | undefined> {
    const current = await this.storage.get(effectId);
    if (!current) {
      return undefined;
    }
    const next = mutate(current);
    await this.storage.save(next);
    return next;
  }
}

