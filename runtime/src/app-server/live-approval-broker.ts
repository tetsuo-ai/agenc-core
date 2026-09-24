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
import { isUndeliverableApproval } from "./approval-delivery.js";
import type { BackgroundAgentDaemonEvent } from "./background-agent-runner/shared.js";
import { AGENC_CROSS_PROVIDER_CONSENT_CAPABILITY, type PendingToolApproval, type JsonObject } from "./protocol/index.js";
import { requestApproval } from "../permissions/guardian/arbiter.js";
import { assertCrossProviderAllowed, crossProviderConsentFromSettings, crossProviderDenialKey, fundsStopFromRolloutItems, type CrossProviderConsentService, type CrossProviderSpawnDisclosure, type CrossProviderConsentOutcome } from "../agents/cross-provider.js";
import { getSessionGoal } from "../goal/session-goal.js";
import type { SubagentFundsNoticeEvent } from "../session/event-log.js";

/**
 * A runtime refusal, not the person's decision (no `decidedBy`): the child's
 * tool never ran, and its turn does not end as a user stop.
 */
const UNDELIVERABLE: ReviewDecision = {
  kind: "denied",
  reason:
    "this sub-agent approval could not be shown to the user, so it was denied and the tool did not run",
};

interface ApprovalOwner {
  readonly session: Session;
  readonly workflow: boolean;
  readonly isActive: () => boolean;
  readonly pending: Map<string, LivePendingApproval>;
  /** Forwarded requests no client could be shown; failed on arrival. */
  readonly undeliverable: Set<string>;
  readonly sessionEpoch: string;
  readonly consentSessionGrants: Set<string>;
  /**
   * Whether a child in this conversation stopped for funds. Unknown until the
   * first consent request reads the owner's journal (`fundsStopped`).
   */
  fundsStopObserved: boolean | undefined;
  readonly deniedConsentPayloads: Set<string>;
}

export interface LivePendingApproval {
  readonly ctx: ApprovalCtx;
  readonly responseKey: string;
  readonly projection: PendingToolApproval;
  readonly settle: (decision: ReviewDecision) => void;
}

/**
 * Whether a person can answer a cross-provider consent question for an owner
 * now. The broker asks by owner run id, which is the daemon agent id; clients
 * attach to that agent's daemon session ids, not to the run id itself.
 */
export function crossProviderConsentAvailability(deps: {
  readonly sessionIdsForAgent: (agentId: string) => Promise<readonly string[]>;
  readonly hasAttachedClientWithCapability: (sessionId: string, capability: string) => Promise<boolean>;
}): (ownerRunId: string) => Promise<boolean> {
  return async (ownerRunId) => {
    for (const sessionId of await deps.sessionIdsForAgent(ownerRunId)) {
      if (await deps.hasAttachedClientWithCapability(sessionId, AGENC_CROSS_PROVIDER_CONSENT_CAPABILITY)) return true;
    }
    return false;
  };
}

export class LiveApprovalBroker {
  readonly #owners = new Map<string, ApprovalOwner>();

  constructor(private readonly options: {
    readonly canAnswerCrossProviderConsent?: (ownerRunId: string) => boolean | Promise<boolean>;
  } = {}) {}

  register(
    session: Session,
    options: {
      readonly workflow?: boolean;
      readonly isActive: () => boolean;
      readonly timeoutMs?: number;
      /**
       * Publishes a forwarded child approval to the owner's clients. Return
       * `false`, a promise that rejects, or a delivery result in which no
       * client received it and none lists pending requests
       * (`isUndeliverableApproval`) when it cannot be shown: the child's
       * request is then denied with a visible reason rather than left pending
       * behind a card nobody can see.
       */
      readonly onEvent?: (event: BackgroundAgentDaemonEvent) => unknown;
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
      undeliverable: new Set(),
      sessionEpoch: randomUUID(),
      consentSessionGrants: new Set(),
      fundsStopObserved: undefined,
      deniedConsentPayloads: new Set(),
    };
    this.#owners.set(session.conversationId, owner);
    const observeFundsStop = (): void => {
      owner.fundsStopObserved = true;
      owner.consentSessionGrants.clear();
    };
    // A restored or test session may carry an event log without live
    // subscriptions; registration must not fail because of it.
    const rootEventLog = session.eventLog;
    const unsubscribeRootFunds = typeof rootEventLog?.subscribe === "function"
      ? rootEventLog.subscribe((event) => {
        if (event.msg.type === "subagent_funds_notice") observeFundsStop();
      })
      : () => {};
    const unsubscribePolicy = session.services.configStore?.subscribe?.(() => {
      // Revoking or changing the operator allowlist retires session grants.
      owner.consentSessionGrants.clear();
    });
    const services = session.services as { approvalResolver?: ApprovalResolver; crossProviderConsent?: CrossProviderConsentService };
    const previousResolver = services.approvalResolver;
    const previousConsent = services.crossProviderConsent;
    const consentService: CrossProviderConsentService = {
      ownerSessionId: owner.session.conversationId,
      sessionEpoch: owner.sessionEpoch,
      request: (requestingSession, disclosure, options) => this.#requestCrossProviderConsent(owner, requestingSession, disclosure, options),
    };
    services.crossProviderConsent = consentService;
    const subscriptions = new Set<() => void>();
    const requestIds = new WeakMap<Session, Map<string, string>>();
    const watchSession = (requestingSession: Session): (() => void) => {
      // Source event IDs are session-local; namespace forwarded occurrences
      // so siblings (and replacement child sessions) cannot collide.
      const eventNamespace = `child-approval:${randomUUID()}`;
      const unmark = owner.workflow ? markWorkflowApprovalSession(requestingSession) : () => {};
      const ids = new Map<string, string>();
      requestIds.set(requestingSession, ids);
      const unsubscribe = requestingSession.eventLog.subscribe((event) => {
        if (event.msg.type === "subagent_funds_notice") {
          observeFundsStop();
          // A nested child's notice is journaled with its parent child, which
          // a restored owner does not read. Copy it into the owner's journal.
          if (requestingSession !== session) journalFundsStop(session, event.msg.payload);
          return;
        }
        if (
          event.msg.type !== "request_permissions" &&
          event.msg.type !== "permission_decision"
        ) return;
        if (this.#owners.get(session.conversationId) !== owner) return;
        const projected = daemonEventFromUnboundSessionEvent(event);
        const callId = projected?.payload?.callId;
        if (projected === null || typeof callId !== "string") return;
        const sourceRequestId = event.msg.type === "request_permissions"
          ? projected.eventId
          : projected.payload?.requestEventId;
        if (typeof sourceRequestId !== "string" || sourceRequestId.length === 0) return;
        let requestId = ids.get(sourceRequestId);
        if (event.msg.type === "request_permissions") {
          if (
            !owner.isActive() ||
            !isApprovalSessionOwnedBy(requestingSession, session)
          ) return;
          requestId ??= `${eventNamespace}:${sourceRequestId}`;
          ids.set(sourceRequestId, requestId);
        } else {
          if (requestId === undefined) return;
          ids.delete(sourceRequestId);
        }
        if (requestingSession !== session || owner.workflow) {
          const delivered = options.onEvent?.({
            id: `${requestId}:${projected.type}`,
            eventId: `${eventNamespace}:${projected.eventId}`,
            type: projected.type,
            payload: {
              ...projected.payload,
              requestId,
              sourceEventId: projected.eventId!,
              sourceConversationId: requestingSession.conversationId,
              ...subAgentAttribution(requestingSession),
            },
            statusProjection: "session_only",
          });
          if (event.msg.type === "request_permissions") {
            const occurrence = requestId;
            if (delivered === false) this.#failUndeliverable(owner, occurrence);
            else if (delivered instanceof Promise) {
              delivered.then(
                (delivery) => {
                  if (isUndeliverableApproval(delivery)) this.#failUndeliverable(owner, occurrence);
                },
                () => this.#failUndeliverable(owner, occurrence),
              );
            }
          } else if (delivered instanceof Promise) {
            delivered.catch(() => {});
          }
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
        const requestId = ctx.invocation.session === session && !owner.workflow
          ? ctx.requestEventId ?? (
              // Only structural legacy embeddings lack a canonical journal.
              !("rolloutStore" in ctx.invocation.session) ? ctx.callId : undefined
            )
          : ctx.requestEventId === undefined
            ? !('rolloutStore' in ctx.invocation.session) ? ctx.callId : undefined
            : requestIds.get(ctx.invocation.session)?.get(ctx.requestEventId);
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
      unsubscribeRootFunds();
      unsubscribePolicy?.();
      for (const cleanup of subscriptions) cleanup();
      session.abortController.signal.removeEventListener("abort", abort);
      if (services.approvalResolver === resolver) {
        if (previousResolver === undefined) delete services.approvalResolver;
        else services.approvalResolver = previousResolver;
      }
      if (services.crossProviderConsent === consentService) {
        if (previousConsent === undefined) delete services.crossProviderConsent;
        else services.crossProviderConsent = previousConsent;
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

  resolve(ownerRunId: string, requestId: string, decision: ReviewDecision,
    options: { readonly approvalKind?: "cross_provider_spawn" } = {}): boolean {
    const pending = this.pending(ownerRunId, requestId);
    if (pending === undefined || pending.ctx.signal?.aborted) return false;
    if (pending.ctx.approvalKind === "cross_provider_spawn" &&
        (decision.kind === "approved" || decision.kind === "approved_for_session") &&
        options.approvalKind !== "cross_provider_spawn") return false;
    const owner = this.#owners.get(ownerRunId)!;
    // A client answering the pending request is the only path a person can
    // take to deny it. A non-interactive client has nobody attached, so its
    // denial is a policy answer, not the user's decision. The broker's own
    // refusals in #request never pass through here.
    const userDecision =
      decision.kind === "denied" && !isNonInteractiveSession(owner.session)
        ? { ...decision, decidedBy: "user" as const }
        : decision;
    // Only a denial of the owner's own call stops the owner. Denying a
    // sub-agent's call stops that sub-agent (its turn ends as the person's
    // stop); latching the owner too would hold back the follow-up turn the
    // child's report starts once the owner's turn has ended.
    if (
      !owner.workflow &&
      pending.ctx.approvalKind !== "cross_provider_spawn" &&
      userDecision.kind === "denied" &&
      userDecision.decidedBy === "user" &&
      pending.ctx.invocation.session === owner.session
    ) {
      owner.session.markStoppedByUser?.();
    }
    pending.settle(userDecision);
    return true;
  }

  async #requestCrossProviderConsent(
    owner: ApprovalOwner,
    requestingSession: Session,
    disclosure: CrossProviderSpawnDisclosure,
    options: { readonly fresh?: boolean } = {},
  ): Promise<CrossProviderConsentOutcome> {
    const unavailable = (reason: string): CrossProviderConsentOutcome => ({
      kind: "consent_unavailable", reason: `${reason} Continue this task yourself.`,
    });
    const activeTurnAtRequest = requestingSession.activeTurn?.unsafePeek()?.turnId;
    const turnId = activeTurnAtRequest ?? disclosure.requestingTurnId ?? disclosure.taskId;
    const denialKey = crossProviderDenialKey(disclosure, turnId);
    const cardDisclosure = { ...disclosure, requestingTurnId: turnId, denialKey };
    if (this.#owners.get(owner.session.conversationId) !== owner || !owner.isActive() ||
        !isApprovalSessionOwnedBy(requestingSession, owner.session)) {
      return unavailable("The interactive session is no longer active.");
    }
    const grant = (kind: "once" | "session") => ({
      kind, ownerSessionId: owner.session.conversationId,
      sessionEpoch: owner.sessionEpoch, taskId: disclosure.taskId,
      scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey,
    });
    // Enabling the allowed providers in settings is the consent, also for
    // unattended runs. After a funds stop the user decides every later spawn.
    if (crossProviderConsentFromSettings(owner.session) && !fundsStopped(owner)) {
      // The consent covers only the providers the settings allow now; a
      // message to an existing child reuses a plan made under older settings.
      try {
        assertCrossProviderAllowed(owner.session, disclosure.provider);
      } catch (error) {
        return unavailable(error instanceof Error ? error.message : String(error));
      }
      return { kind: "granted", grant: grant("session") };
    }
    if (owner.workflow || isNonInteractiveSession(owner.session) ||
        getSessionGoal(owner.session)?.status === "active" ||
        (owner.session.activeTurn?.unsafePeek() !== undefined &&
          owner.session.activeTurn.unsafePeek() !== null &&
          owner.session.currentRootHumanTurn() === null) ||
        owner.session.services.deferInteractiveApprovals !== undefined) {
      return unavailable("This run is unattended and cannot request human consent.");
    }
    if (this.options.canAnswerCrossProviderConsent === undefined ||
        !(await this.options.canAnswerCrossProviderConsent(owner.session.conversationId))) {
      return unavailable("No attached consent-capable client can answer now.");
    }
    if (requestingSession.activeTurn?.unsafePeek()?.turnId !== activeTurnAtRequest ||
        this.#owners.get(owner.session.conversationId) !== owner || !owner.isActive() ||
        !isApprovalSessionOwnedBy(requestingSession, owner.session)) {
      return unavailable("The requesting turn is no longer active.");
    }
    if (owner.deniedConsentPayloads.has(denialKey)) {
      return { kind: "consent_denied", reason: "This task's equivalent cross-provider request was already denied. Continue it yourself; do not retry the same request." };
    }
    // Once any child hits a funds stop, task text cannot identify a retry.
    // Session-wide fresh approval is intentionally stricter than lineage-only
    // invalidation and cannot be evaded by changing the model's task wording.
    if (options.fresh !== true && !fundsStopped(owner) &&
        owner.consentSessionGrants.has(disclosure.scopeKey)) {
      return { kind: "granted", grant: grant("session") };
    }
    const callId = `cross-provider-consent:${disclosure.taskId}:${randomUUID()}`;
    // The arbiter settles a modal as stale unless it belongs to the session's
    // active turn, and clients match a request to that turn: use its id, not
    // the spawn call's.
    const result = await requestApproval({
      ctx: {
        invocation: {
          session: requestingSession, callId,
          payload: { kind: "function", arguments: JSON.stringify(cardDisclosure) },
        } as Parameters<typeof requestApproval>[0]["ctx"]["invocation"],
        callId, toolName: "spawn_agent", approvalKind: "cross_provider_spawn",
        turnId, requiresUserInteraction: true,
        signal: requestingSession.abortController.signal,
      },
      args: cardDisclosure as unknown as Record<string, unknown>,
      resolver: requestingSession.services.approvalResolver,
      signal: requestingSession.abortController.signal,
    });
    if (result.source !== "resolver" ||
        (result.decision.kind !== "approved" &&
         result.decision.kind !== "approved_for_session" &&
         (result.decision.kind !== "denied" || result.decision.decidedBy !== "user"))) {
      return unavailable("Human consent could not be obtained.");
    }
    if (result.decision.kind === "approved_for_session") {
      owner.consentSessionGrants.add(disclosure.scopeKey);
      return { kind: "granted", grant: grant("session") };
    }
    if (result.decision.kind === "approved") return { kind: "granted", grant: grant("once") };
    owner.deniedConsentPayloads.add(denialKey);
    return { kind: "consent_denied", reason: "The user denied this cross-provider child. Continue the subtask yourself and do not retry the same request." };
  }

  abort(ownerRunId: string): void {
    for (const pending of this.#owners.get(ownerRunId)?.pending.values() ?? []) {
      pending.settle(ABORT);
    }
  }

  #failUndeliverable(owner: ApprovalOwner, requestId: string): void {
    const pending = owner.pending.get(requestId);
    if (pending === undefined) {
      // The resolver has not registered it yet; #request fails it on arrival.
      owner.undeliverable.add(requestId);
      return;
    }
    pending.settle(UNDELIVERABLE);
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
      owner.pending.has(requestId) ||
      // Preserve the old one-pending-decision-per-invocation invariant even
      // though sequential scopes now use distinct occurrence IDs.
      [...owner.pending.values()].some((pending) =>
        pending.ctx.invocation.session === requestingSession && pending.ctx.callId === ctx.callId)
    ) {
      return Promise.resolve(DENIED);
    }
    if (owner.undeliverable.delete(requestId)) return Promise.resolve(UNDELIVERABLE);
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
          ...(requestingSession === owner.session ? {} : subAgentAttribution(requestingSession)),
          requestId,
          ...(ctx.approvalKind !== undefined ? { kind: ctx.approvalKind } : {}),
          ...(ctx.approvalKind === "cross_provider_spawn" && approvalInput(ctx) !== undefined
            ? { crossProvider: approvalInput(ctx) as unknown as import("./protocol/index.js").CrossProviderSpawnDisclosure }
            : {}),
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

function isNonInteractiveSession(session: Session): boolean {
  return (
    session.services as { readonly runtimeOptions?: { readonly nonInteractive?: unknown } } | undefined
  )?.runtimeOptions?.nonInteractive === true;
}

/**
 * Whether a child in the owner's conversation stopped for funds, including
 * before a daemon restart. The owner's journal is read once, when consent
 * first needs it; live notices set the flag after that.
 */
function fundsStopped(owner: ApprovalOwner): boolean {
  owner.fundsStopObserved ??= journaledFundsStop(owner.session);
  return owner.fundsStopObserved;
}

/**
 * Whether the owner's journal records a child's funds stop. A journal that
 * cannot be read cannot show that no child stopped, so it counts as a stop.
 */
function journaledFundsStop(session: Session): boolean {
  const journal = session.rolloutStore;
  if (typeof journal?.readAll !== "function") return false;
  try {
    return fundsStopFromRolloutItems(journal.readAll());
  } catch {
    return true;
  }
}

/**
 * Journals a nested child's funds notice durably with the owner, as the same
 * event a direct child writes there, so the owner reads it after a restart.
 */
function journalFundsStop(owner: Session, notice: SubagentFundsNoticeEvent): void {
  if (typeof owner.emit !== "function" || typeof owner.nextInternalSubId !== "function") return;
  try {
    owner.emit({
      id: owner.nextInternalSubId(),
      msg: { type: "subagent_funds_notice", payload: notice },
    }, { durable: true });
  } catch {
    // A sealed or failed journal cannot take the copy; the live flag still
    // holds while this owner stays registered.
  }
}

/**
 * Who is asking, for a request forwarded from a spawned sub-agent. The
 * owner's client sees only the child's session id; the nickname and path let
 * it say "Sub-agent X wants to ..." even for a nested child it never saw
 * spawn.
 */
function subAgentAttribution(session: Session): {
  readonly sourceAgentNickname?: string;
  readonly sourceAgentPath?: string;
} {
  const source = (session as { readonly sessionConfiguration?: Session["sessionConfiguration"] })
    .sessionConfiguration?.sessionSource;
  if (typeof source !== "object" || source.kind !== "subagent" || source.source.kind !== "thread_spawn") {
    return {};
  }
  const { agentNickname, agentPath } = source.source;
  return {
    ...(typeof agentNickname === "string" && agentNickname.length > 0
      ? { sourceAgentNickname: agentNickname }
      : {}),
    ...(typeof agentPath === "string" && agentPath.length > 0
      ? { sourceAgentPath: agentPath }
      : {}),
  };
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
