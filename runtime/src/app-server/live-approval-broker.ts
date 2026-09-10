import { randomUUID } from "node:crypto";
import type { Session } from "../session/session.js";
import type { ApprovalCtx, ApprovalResolver } from "../tools/orchestrator.js";
import {
  ABORT,
  DENIED,
  TIMED_OUT,
  type ReviewDecision,
} from "../permissions/review-decision.js";
import {
  childApprovalRevocationSignal,
  isApprovalSessionOwnedBy,
  observeChildApprovalSessions,
} from "../agents/child-approval-context.js";
import { markWorkflowApprovalSession } from "../permissions/approval-failure.js";
import {
  bindApprovalResponseKey,
  clearApprovalResponseKey,
} from "../permissions/approval-response-key.js";
import { daemonEventFromUnboundSessionEvent } from "./background-agent-runner/daemon-events.js";
import type { BackgroundAgentDaemonEvent } from "./background-agent-runner/shared.js";
import type { PendingToolApproval, JsonObject } from "./protocol/index.js";

interface ApprovalOwner {
  readonly session: Session;
  readonly workflow: boolean;
  readonly isActive: () => boolean;
  readonly pending: Map<string, LivePendingApproval>;
}

export interface LivePendingApproval {
  readonly ctx: ApprovalCtx;
  readonly responseKey: string;
  readonly projection: PendingToolApproval;
  readonly settle: (decision: ReviewDecision) => void;
}

export class LiveApprovalBroker {
  readonly #owners = new Map<string, ApprovalOwner>();

  register(
    session: Session,
    options: {
      readonly workflow?: boolean;
      readonly isActive: () => boolean;
      readonly timeoutMs?: number;
      readonly onEvent?: (event: BackgroundAgentDaemonEvent) => void;
    },
  ): () => void {
    if (this.#owners.has(session.conversationId)) {
      throw new Error(`Approval owner is already registered: ${session.conversationId}`);
    }
    const owner: ApprovalOwner = {
      session,
      workflow: options.workflow === true,
      isActive: options.isActive,
      pending: new Map(),
    };
    this.#owners.set(session.conversationId, owner);
    const services = session.services as { approvalResolver?: ApprovalResolver };
    const previousResolver = services.approvalResolver;
    const subscriptions = new Set<() => void>();
    const requestIds = new WeakMap<Session, Map<string, string>>();
    const watchSession = (requestingSession: Session): (() => void) => {
      const unmark = owner.workflow ? markWorkflowApprovalSession(requestingSession) : () => {};
      const ids = new Map<string, string>();
      requestIds.set(requestingSession, ids);
      const unsubscribe = requestingSession.eventLog.subscribe((event) => {
        if (
          event.msg.type !== "request_permissions" &&
          event.msg.type !== "permission_decision"
        ) return;
        if (this.#owners.get(session.conversationId) !== owner) return;
        const projected = daemonEventFromUnboundSessionEvent(event);
        const callId = projected?.payload?.callId;
        if (projected === null || typeof callId !== "string") return;
        let requestId = ids.get(callId);
        if (event.msg.type === "request_permissions") {
          if (
            !owner.isActive() ||
            !isApprovalSessionOwnedBy(requestingSession, session)
          ) return;
          requestId = requestingSession === session && !owner.workflow
            ? callId
            : `child-approval:${randomUUID()}`;
          ids.set(callId, requestId);
        } else {
          if (requestId === undefined) return;
          ids.delete(callId);
        }
        if (requestingSession !== session || owner.workflow) {
          options.onEvent?.({
            id: `${requestId}:${projected.type}`,
            type: projected.type,
            payload: { ...projected.payload, callId: requestId },
            statusProjection: "session_only",
          });
        }
      });
      const cleanup = () => {
        unsubscribe();
        unmark();
        requestIds.delete(requestingSession);
        subscriptions.delete(cleanup);
      };
      subscriptions.add(cleanup);
      return cleanup;
    };
    if (owner.workflow) watchSession(session);
    const unsubscribeChildren = observeChildApprovalSessions(session, watchSession);
    const resolver: ApprovalResolver = {
      request: (ctx) => {
        const requestId = requestIds.get(ctx.invocation.session)?.get(ctx.callId) ??
          (ctx.invocation.session === session && !owner.workflow ? ctx.callId : undefined);
        return this.#request(owner, ctx, requestId, options.timeoutMs);
      },
    };
    services.approvalResolver = resolver;
    const abort = () => this.abort(session.conversationId);
    session.abortController.signal.addEventListener("abort", abort, { once: true });
    return () => {
      if (this.#owners.get(session.conversationId) !== owner) return;
      this.abort(session.conversationId);
      this.#owners.delete(session.conversationId);
      unsubscribeChildren();
      for (const cleanup of subscriptions) cleanup();
      session.abortController.signal.removeEventListener("abort", abort);
      if (services.approvalResolver === resolver) {
        if (previousResolver === undefined) delete services.approvalResolver;
        else services.approvalResolver = previousResolver;
      }
    };
  }

  getOwner(ownerRunId: string): Session | undefined {
    const owner = this.#owners.get(ownerRunId);
    return owner?.isActive() ? owner.session : undefined;
  }

  isWorkflowOwner(ownerRunId: string): boolean {
    const owner = this.#owners.get(ownerRunId);
    return owner?.workflow === true && owner.isActive();
  }

  list(ownerRunId: string): readonly PendingToolApproval[] {
    const owner = this.#owners.get(ownerRunId);
    return owner?.isActive()
      ? [...owner.pending.values()].map((pending) => structuredClone(pending.projection))
      : [];
  }

  pending(ownerRunId: string, requestId: string): LivePendingApproval | undefined {
    const owner = this.#owners.get(ownerRunId);
    const pending = owner?.pending.get(requestId);
    if (owner === undefined || pending === undefined || !owner.isActive()) return undefined;
    return isApprovalSessionOwnedBy(pending.ctx.invocation.session, owner.session)
      ? pending
      : undefined;
  }

  hasPending(ownerRunId: string): boolean {
    return (this.#owners.get(ownerRunId)?.pending.size ?? 0) > 0;
  }

  resolve(ownerRunId: string, requestId: string, decision: ReviewDecision): boolean {
    const pending = this.pending(ownerRunId, requestId);
    if (pending === undefined || pending.ctx.signal?.aborted) return false;
    pending.settle(decision);
    return true;
  }

  abort(ownerRunId: string): void {
    for (const pending of this.#owners.get(ownerRunId)?.pending.values() ?? []) {
      pending.settle(ABORT);
    }
  }

  #request(
    owner: ApprovalOwner,
    ctx: ApprovalCtx,
    requestId: string | undefined,
    timeoutMs: number | undefined,
  ): Promise<ReviewDecision> {
    const requestingSession = ctx.invocation.session;
    if (
      this.#owners.get(owner.session.conversationId) !== owner ||
      !owner.isActive() ||
      !isApprovalSessionOwnedBy(requestingSession, owner.session) ||
      requestId === undefined ||
      owner.pending.has(requestId)
    ) {
      return Promise.resolve(DENIED);
    }
    const ownershipSignal = childApprovalRevocationSignal(requestingSession);
    if (
      ctx.signal?.aborted ||
      ownershipSignal?.aborted ||
      owner.session.abortController.signal.aborted
    ) return Promise.resolve(ABORT);
    const responseKey = bindApprovalResponseKey(requestingSession, ctx.callId);
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => settle(ABORT);
      const settle = (decision: ReviewDecision) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", abort);
        ownershipSignal?.removeEventListener("abort", abort);
        owner.pending.delete(requestId);
        const effective =
          this.#owners.get(owner.session.conversationId) === owner &&
          owner.isActive() &&
          isApprovalSessionOwnedBy(requestingSession, owner.session)
            ? decision
            : ABORT;
        if (effective.kind !== "approved" && effective.kind !== "approved_for_session") {
          clearApprovalResponseKey(requestingSession, ctx.callId);
        }
        resolve(effective);
      };
      owner.pending.set(requestId, {
        ctx,
        responseKey,
        settle,
        projection: {
          ownerRunId: owner.session.conversationId,
          sessionId: requestingSession.conversationId,
          requestId,
          toolName: ctx.toolName,
          turnId: ctx.turnId,
          ...(approvalInput(ctx) !== undefined ? { input: approvalInput(ctx) } : {}),
          ...(ctx.retryReason !== undefined ? { reason: ctx.retryReason } : {}),
          ...(ctx.planContent !== undefined ? { planContent: ctx.planContent } : {}),
          ...(ctx.planFilePath !== undefined ? { planFilePath: ctx.planFilePath } : {}),
          ...(ctx.fileWritePreview !== undefined
            ? { fileWritePreview: ctx.fileWritePreview }
            : {}),
        },
      });
      ctx.signal?.addEventListener("abort", abort, { once: true });
      ownershipSignal?.addEventListener("abort", abort, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => settle(TIMED_OUT), timeoutMs);
      if (ctx.signal?.aborted || ownershipSignal?.aborted) abort();
    });
  }
}

function approvalInput(ctx: ApprovalCtx): JsonObject | undefined {
  const payload = ctx.invocation.payload;
  try {
    const value = payload.kind === "function" ? JSON.parse(payload.arguments)
      : payload.kind === "mcp" ? JSON.parse(payload.rawArguments)
      : payload.kind === "local_shell" ? payload.params
      : payload.kind === "tool_search" ? payload.arguments
      : { input: payload.input };
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? JSON.parse(JSON.stringify(value)) as JsonObject
      : undefined;
  } catch {
    return undefined;
  }
}
