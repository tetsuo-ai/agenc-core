import { describe, expect, it, vi } from "vitest";
import {
  buildCrossProviderDisclosure,
  consentGrantCoversPlan,
  withChildConsentGrant,
  authorizeChildExecutionPlan,
  assertChildExecutionPlan,
  type ChildExecutionPlan,
} from "../../src/agents/cross-provider.js";
import { LiveApprovalBroker } from "../../src/app-server/live-approval-broker.js";
import type { Session } from "../../src/session/session.js";
import { registerChildApprovalSession } from "../../src/agents/child-approval-context.js";
import { childTerminalOutcome } from "../../src/agents/child-terminal.js";
import { restoreSessionGoal } from "../../src/goal/session-goal.js";

const plan = {
  version: 1,
  route: { provider: "deepseek", model: "deepseek-v4-pro" },
  destination: { provider: "deepseek", model: "deepseek-v4-pro", endpoint: "https://api.deepseek.com/v1", authProfile: "api_key", billingSource: "byok" },
  modelInfo: { slug: "deepseek-v4-pro" },
  catalogRevision: "catalog-v1:a", requiredCapabilities: { clientTools: true },
  parent: { sessionId: "root-session", agentPath: "/root" },
  task: { id: "task-one", name: "research", text: "Read the design", attachments: [] },
  scope: { tools: ["Read", "WebSearch"], data: "task_only", cwd: "/workspace" },
  policyRevision: "agents-v1:a", consentGrant: null, budgetAllocation: { maxModelCalls: 32 },
  crossProvider: true,
} as unknown as ChildExecutionPlan;

describe("cross-provider consent grants", () => {
  it("discloses the exact payload, destination, billing, tools and price", () => {
    const disclosure = buildCrossProviderDisclosure(plan, "Read the design", ["design.pdf"]);
    expect(disclosure).toMatchObject({ kind: "cross_provider_spawn", provider: "deepseek", model: "deepseek-v4-pro", billingSource: "byok", taskText: "Read the design", attachments: ["design.pdf"], workspace: "/workspace", tools: ["Read", "WebSearch"], search: true });
    expect(disclosure.futureToolResultsGoToProvider).toBe(true);
    expect(disclosure.price).toBeDefined();
  });

  it("labels an unpriced destination without guessing a zero price", () => {
    const unknown = { ...plan, destination: { ...plan.destination, model: "unlisted-model" } };
    expect(buildCrossProviderDisclosure(unknown).price).toBe("price unknown");
  });

  it("discloses sign-in billing and subscription limits without API unit prices", () => {
    const signedIn = { ...plan, destination: { ...plan.destination,
      provider: "openai", model: "gpt-6-luna", endpoint: "https://chatgpt.com/backend-api/codex",
      authProfile: "sign_in", billingSource: "sign_in" } } as ChildExecutionPlan;
    expect(buildCrossProviderDisclosure(signedIn)).toMatchObject({ provider: "openai",
      model: "gpt-6-luna", billingSource: "sign_in", price: "price unknown",
      subscriptionUsageNote: "Usage counts against your subscription limits." });
  });

  it("allow once covers only the same logical task and payload", () => {
    const disclosure = buildCrossProviderDisclosure(plan, "Read the design", []);
    const granted = withChildConsentGrant(plan, { kind: "once", ownerSessionId: "root-session", sessionEpoch: "epoch", taskId: "task-one", scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey });
    expect(consentGrantCoversPlan(granted, "root-session", "Read the design", [])).toBe(true);
    expect(consentGrantCoversPlan(granted, "root-session", "Read a secret", [])).toBe(false);
    expect(consentGrantCoversPlan({ ...granted, task: { id: "task-two", name: "research", text: "Read the design", attachments: [] } }, "root-session", "Read the design", [])).toBe(false);
  });

  it("session grants stay within model, data scope, and live session", () => {
    const disclosure = buildCrossProviderDisclosure(plan, "Read the design", []);
    const granted = withChildConsentGrant(plan, { kind: "session", ownerSessionId: "root-session", sessionEpoch: "epoch", taskId: "task-one", scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey });
    expect(consentGrantCoversPlan(granted, "root-session", "Another task", [])).toBe(true);
    expect(consentGrantCoversPlan(granted, "new-session", "Another task", [])).toBe(false);
    expect(consentGrantCoversPlan({ ...granted, destination: { ...granted.destination, model: "other" } }, "root-session", "Another task", [])).toBe(false);
  });

  it("resume blocks a missing grant", () => {
    expect(consentGrantCoversPlan(plan, "root-session", "Read the design", [])).toBe(false);
  });

  it("resume refuses a missing or expired grant before provider setup", async () => {
    const fixture = interactiveFixture();
    try {
      await expect(assertChildExecutionPlan(fixture.session, plan)).rejects.toThrow(/resume_blocked/u);
      const disclosure = buildCrossProviderDisclosure(plan);
      const expired = withChildConsentGrant(plan, { kind: "once", ownerSessionId: "root-session",
        sessionEpoch: "ended-session", taskId: plan.task.id,
        scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey });
      await expect(assertChildExecutionPlan(fixture.session, expired)).rejects.toThrow(/resume_blocked/u);
    } finally { fixture.close(); }
  });
});

/** The user enabled cross-provider subagents and asked to confirm each spawn. */
const ASK_EACH_SPAWN = { cross_provider_enabled: true, allowed_providers: ["deepseek"], cross_provider_ask_each_spawn: true };
/** The user enabled cross-provider subagents, so settings are the consent. */
const SETTINGS_CONSENT = { cross_provider_enabled: true, allowed_providers: ["deepseek"] };

function interactiveFixture(options: { answerable?: boolean; nonInteractive?: boolean; workflow?: boolean; goal?: boolean; autonomousTick?: boolean; activeTurnId?: string; agents?: Record<string, unknown>; journal?: unknown[] } = {}) {
  let stopped = false;
  let answerable = options.answerable !== false;
  const eventListeners = new Set<(event: unknown) => void>();
  const publish = (event: unknown) => { for (const listener of eventListeners) listener(event); };
  // With a journal the owner is canonical: like Session.emit, a durable event
  // is stamped and journaled before listeners see it. A second fixture given
  // the same journal is the conversation restored after a daemon restart.
  const journal = options.journal;
  let sequence = journal?.length ?? 0;
  const session = {
    conversationId: "root-session",
    services: { runtimeOptions: { nonInteractive: options.nonInteractive === true } },
    abortController: new AbortController(),
    markStoppedByUser: () => { stopped = true; },
    eventLog: { subscribe: (listener: (event: unknown) => void) => {
      eventListeners.add(listener); return () => { eventListeners.delete(listener); };
    } },
    ...(journal !== undefined ? {
      rolloutStore: { readAll: () => [...journal] },
      nextInternalSubId: () => `root-internal-${sequence + 1}`,
      emit: (event: { readonly eventId?: string }) => {
        sequence += 1;
        const stamped = { ...event, eventId: event.eventId ?? `event:${sequence}`, seq: sequence };
        journal.push({ type: "event_msg", payload: stamped });
        publish(stamped);
        return stamped;
      },
    } : {}),
    onBeforeDurableClose: () => () => {},
    config: { agents: options.agents ?? ASK_EACH_SPAWN },
    ...(options.autonomousTick ? { activeTurn: { unsafePeek: () => ({ turnId: "tick" }) }, currentRootHumanTurn: () => null } : {}),
    ...(options.activeTurnId !== undefined ? {
      activeTurn: { unsafePeek: () => ({ turnId: options.activeTurnId }) },
      currentRootHumanTurn: () => ({ turnId: options.activeTurnId }),
    } : {}),
  } as unknown as Session;
  const broker = new LiveApprovalBroker({ canAnswerCrossProviderConsent: () => answerable });
  const close = broker.register(session, { isActive: () => true, workflow: options.workflow === true });
  if (options.goal) restoreSessionGoal(session, { objective: "unattended work", status: "active" } as never);
  return { session, broker, close, journal: journal ?? [], stopped: () => stopped,
    setAnswerable: (value: boolean) => { answerable = value; },
    /** A live event on the owner's log that is not journaled. */
    emit: publish,
    /** A durable event on the owner's log, as a direct child's funds notice is. */
    emitDurable: (event: unknown) => { (session as unknown as { emit(event: unknown): unknown }).emit(event); },
  };
}

/** The funds notices in an owner's journal. */
function journaledFundsNotices(journal: readonly unknown[]): unknown[] {
  return journal.filter((item) =>
    (item as { payload?: { msg?: { type?: unknown } } }).payload?.msg?.type === "subagent_funds_notice");
}

/** A child session under the fixture's owner, with an event log of its own. */
function childOf(fixture: ReturnType<typeof interactiveFixture>) {
  const listeners = new Set<(event: unknown) => void>();
  const session = {
    conversationId: "child-session", services: { ...fixture.session.services },
    abortController: new AbortController(),
    eventLog: { subscribe: (listener: (event: unknown) => void) => {
      listeners.add(listener); return () => { listeners.delete(listener); };
    } },
    onBeforeDurableClose: () => () => {},
    sessionConfiguration: { sessionSource: { kind: "subagent", source: { kind: "thread_spawn",
      parentThreadId: "root-session", depth: 1, agentPath: "/root/worker" } } },
  } as unknown as Session;
  registerChildApprovalSession(session, fixture.session);
  return { session, emit: (event: unknown) => { for (const listener of listeners) listener(event); } };
}

/** The durable notice run-agent emits on a parent whose child stopped for funds. */
function fundsNotice(agentPath: string) {
  return { id: `funds:${agentPath}`, msg: { type: "subagent_funds_notice", payload: {
    agentPath, taskId: "task-one", taskText: "Read the design",
    terminal: childTerminalOutcome({ provider: "deepseek", model: "deepseek-v4-pro",
      reason: "insufficient_funds", dispatch: "sent", unfinishedWork: "Read the design" }),
    message: "deepseek/deepseek-v4-pro ran out of credits. The child stopped; ask before switching providers.",
  } } };
}

/** A spawn by the child session at the next depth. */
const nestedPlan = { ...plan, parent: { sessionId: "child-session", agentPath: "/root/worker" },
  task: { id: "grandchild", name: "grandchild", text: "Research", attachments: [] } } as ChildExecutionPlan;

async function pendingDecision(fixture: ReturnType<typeof interactiveFixture>, task: ChildExecutionPlan = plan) {
  const promise = authorizeChildExecutionPlan(fixture.session, task);
  await vi.waitFor(() => expect(fixture.broker.list("root-session")).toHaveLength(1));
  return { promise, pending: fixture.broker.list("root-session")[0]! };
}

describe("live cross-provider consent", () => {
  it.each(["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"])(
    "asks in %s permission mode", async (mode) => {
      const fixture = interactiveFixture();
      Object.assign(fixture.session.services, { permissionModeRegistry: { current: () => mode } });
      try {
        const { promise, pending } = await pendingDecision(fixture);
        expect(pending.kind).toBe("cross_provider_spawn");
        expect(pending.crossProvider).toMatchObject({ taskText: "Read the design", provider: "deepseek" });
        expect(fixture.broker.resolve("root-session", pending.requestId, { kind: "denied" })).toBe(true);
        expect(await promise).toMatchObject({ kind: "consent_denied" });
        expect(fixture.stopped()).toBe(false);
      } finally { fixture.close(); }
    },
  );

  it("asks on the session's active turn so the answer is not dropped as stale", async () => {
    // A live run was refused: the request carried the spawn call id as its
    // turn, and the arbiter aborted it before anyone could answer.
    const fixture = interactiveFixture({ activeTurnId: "turn-7" });
    try {
      const { promise, pending } = await pendingDecision(fixture);
      expect(pending.turnId).toBe("turn-7");
      expect(fixture.broker.resolve("root-session", pending.requestId, { kind: "approved" },
        { approvalKind: "cross_provider_spawn" })).toBe(true);
      expect((await promise).kind).toBe("granted");
    } finally { fixture.close(); }
  });

  it("rejects a consent request when its requesting turn changes during the capability check", async () => {
    let answerCapability!: (answer: boolean) => void;
    const capability = new Promise<boolean>((resolve) => { answerCapability = resolve; });
    let activeTurnId = "turn-a";
    const session = {
      conversationId: "root-session",
      services: {},
      abortController: new AbortController(),
      activeTurn: { unsafePeek: () => ({ turnId: activeTurnId }) },
      currentRootHumanTurn: () => ({ turnId: activeTurnId }),
      eventLog: { subscribe: () => () => {} },
      onBeforeDurableClose: () => () => {},
      config: { agents: ASK_EACH_SPAWN },
    } as unknown as Session;
    const broker = new LiveApprovalBroker({ canAnswerCrossProviderConsent: () => capability });
    const close = broker.register(session, { isActive: () => true });
    const request = authorizeChildExecutionPlan(session, {
      ...plan, task: { ...plan.task, parentTurnId: "turn-a" },
    });
    try {
      activeTurnId = "turn-b";
      answerCapability(true);
      await expect(request).resolves.toMatchObject({ kind: "consent_unavailable" });
      expect(broker.list("root-session")).toHaveLength(0);
      const onTurnB = { ...plan, task: { ...plan.task,
        id: "turn-b-task", parentTurnId: "turn-b" } };
      const second = authorizeChildExecutionPlan(session, onTurnB);
      await vi.waitFor(() => expect(broker.list("root-session")).toHaveLength(1));
      const card = broker.list("root-session")[0]!;
      expect(card.turnId).toBe("turn-b");
      expect(card.crossProvider?.denialKey)
        .toBe(buildCrossProviderDisclosure(onTurnB).denialKey);
      broker.resolve("root-session", card.requestId, { kind: "denied" });
      await expect(second).resolves.toMatchObject({ kind: "consent_denied" });
      await expect(authorizeChildExecutionPlan(session, { ...onTurnB,
        task: { ...onTurnB.task, id: "turn-b-retry" } }))
        .resolves.toMatchObject({ kind: "consent_denied" });
      expect(broker.list("root-session")).toHaveLength(0);
    } finally {
      broker.abort("root-session");
      close();
    }
  });

  it("allows once and old clients cannot approve an unknown kind", async () => {
    const fixture = interactiveFixture();
    try {
      const { promise, pending } = await pendingDecision(fixture);
      expect(fixture.broker.resolve("root-session", pending.requestId, { kind: "approved" })).toBe(false);
      expect(fixture.broker.resolve("root-session", pending.requestId, { kind: "approved" },
        { approvalKind: "cross_provider_spawn" })).toBe(true);
      const result = await promise;
      expect(result.kind).toBe("granted");
      if (result.kind === "granted") expect(result.plan.consentGrant?.kind).toBe("once");
    } finally { fixture.close(); }
  });

  it("allows for the session within the same disclosure scope", async () => {
    const fixture = interactiveFixture();
    try {
      const { promise, pending } = await pendingDecision(fixture);
      fixture.broker.resolve("root-session", pending.requestId, { kind: "approved_for_session" },
        { approvalKind: "cross_provider_spawn" });
      expect((await promise).kind).toBe("granted");
      const second = { ...plan, task: { id: "task-two", name: "research", text: "Another task", attachments: [] } };
      const reused = await authorizeChildExecutionPlan(fixture.session, second);
      expect(reused.kind).toBe("granted");
      expect(fixture.broker.list("root-session")).toHaveLength(0);
      if (reused.kind === "granted") expect(reused.plan.consentGrant?.kind).toBe("session");
      const wider = { ...second, destination: { ...second.destination, model: "other-model" } };
      const question = await pendingDecision(fixture, wider);
      fixture.broker.resolve("root-session", question.pending.requestId, { kind: "denied" });
      expect((await question.promise).kind).toBe("consent_denied");
    } finally { fixture.close(); }
  });

  it("requires a fresh visible approval for a passive message despite a session grant", async () => {
    const fixture = interactiveFixture();
    try {
      const first = await pendingDecision(fixture);
      fixture.broker.resolve("root-session", first.pending.requestId, { kind: "approved_for_session" },
        { approvalKind: "cross_provider_spawn" });
      expect((await first.promise).kind).toBe("granted");
      const messagePlan = { ...plan, task: { ...plan.task, id: "message-1", text: "private update" } };
      const pending = authorizeChildExecutionPlan(fixture.session, messagePlan, { fresh: true });
      await vi.waitFor(() => expect(fixture.broker.list("root-session")).toHaveLength(1));
      const card = fixture.broker.list("root-session")[0]!;
      expect(card.crossProvider?.taskText).toBe("private update");
      fixture.broker.resolve("root-session", card.requestId, { kind: "approved" },
        { approvalKind: "cross_provider_spawn" });
      expect((await pending).kind).toBe("granted");
    } finally { fixture.close(); }
  });

  it("does not reuse an interactive session grant after the human client detaches", async () => {
    const fixture = interactiveFixture();
    try {
      const first = await pendingDecision(fixture);
      fixture.broker.resolve("root-session", first.pending.requestId, { kind: "approved_for_session" },
        { approvalKind: "cross_provider_spawn" });
      expect((await first.promise).kind).toBe("granted");
      fixture.setAnswerable(false);
      const second = { ...plan, task: { id: "unattended-task", name: "research", text: "Another task", attachments: [] } };
      expect((await authorizeChildExecutionPlan(fixture.session, second)).kind).toBe("consent_unavailable");
    } finally { fixture.close(); }
  });

  it("asks again when a reusable worker receives a second task after allow once", async () => {
    const fixture = interactiveFixture();
    try {
      const first = await pendingDecision(fixture);
      fixture.broker.resolve("root-session", first.pending.requestId, { kind: "approved" },
        { approvalKind: "cross_provider_spawn" });
      expect((await first.promise).kind).toBe("granted");
      const second = { ...plan, task: { id: "assignment-two", name: "research", text: "Second task", attachments: [] } };
      const next = await pendingDecision(fixture, second);
      expect(next.pending.crossProvider).toMatchObject({ taskId: "assignment-two", taskText: "Second task" });
      fixture.broker.resolve("root-session", next.pending.requestId, { kind: "denied" });
      expect((await next.promise).kind).toBe("consent_denied");
    } finally { fixture.close(); }
  });

  it("denial suppresses the same task request and never stops the parent", async () => {
    const fixture = interactiveFixture();
    try {
      const { promise, pending } = await pendingDecision(fixture);
      fixture.broker.resolve("root-session", pending.requestId, { kind: "denied" });
      expect((await promise).kind).toBe("consent_denied");
      expect((await authorizeChildExecutionPlan(fixture.session, plan)).kind).toBe("consent_denied");
      const retry = { ...plan, task: { ...plan.task, id: "new-call-id" } };
      expect((await authorizeChildExecutionPlan(fixture.session, retry)).kind).toBe("consent_denied");
      expect(fixture.broker.list("root-session")).toHaveLength(0);
      expect(fixture.stopped()).toBe(false);
    } finally { fixture.close(); }
  });

  it("treats an abandoned prompt as unavailable, not as a human denial", async () => {
    const fixture = interactiveFixture();
    try {
      const { promise } = await pendingDecision(fixture);
      fixture.broker.abort("root-session");
      expect(await promise).toMatchObject({ kind: "consent_unavailable" });
    } finally { fixture.close(); }
  });

  it("still asks with an unrestricted sandbox", async () => {
    const fixture = interactiveFixture();
    Object.assign(fixture.session, { sessionConfiguration: { sandboxPolicy: { value: "danger_full_access" } } });
    try {
      const { promise, pending } = await pendingDecision(fixture);
      expect(pending.kind).toBe("cross_provider_spawn");
      fixture.broker.resolve("root-session", pending.requestId, { kind: "denied" });
      expect((await promise).kind).toBe("consent_denied");
    } finally { fixture.close(); }
  });

  it.each([{ answerable: false }, { nonInteractive: true }, { workflow: true },
    { goal: true }, { autonomousTick: true }])(
    "fails immediately when the user asks at each spawn and consent is unavailable: %j", async (options) => {
      const fixture = interactiveFixture(options);
      try {
        await expect(authorizeChildExecutionPlan(fixture.session, plan)).resolves.toMatchObject({ kind: "consent_unavailable" });
        expect(fixture.broker.list("root-session")).toHaveLength(0);
      } finally { fixture.close(); }
    },
  );

  it("asks separately at a nested provider edge through the root owner", async () => {
    const fixture = interactiveFixture();
    const child = {
      conversationId: "child-session", services: { ...fixture.session.services },
      abortController: new AbortController(), eventLog: { subscribe: () => () => {} },
      onBeforeDurableClose: () => () => {},
      sessionConfiguration: { sessionSource: { kind: "subagent", source: { kind: "thread_spawn",
        parentThreadId: "root-session", depth: 1, agentPath: "/root/worker" } } },
    } as unknown as Session;
    registerChildApprovalSession(child, fixture.session);
    try {
      const first = await pendingDecision(fixture);
      fixture.broker.resolve("root-session", first.pending.requestId, { kind: "approved" },
        { approvalKind: "cross_provider_spawn" });
      expect((await first.promise).kind).toBe("granted");
      const thirdProvider = { ...plan,
        parent: { sessionId: "child-session", agentPath: "/root/worker" },
        task: { id: "grandchild", name: "grandchild", text: "Research", attachments: [] },
        destination: { ...plan.destination, provider: "openai", model: "gpt-5.4" } };
      const next = authorizeChildExecutionPlan(child, thirdProvider);
      await vi.waitFor(() => expect(fixture.broker.list("root-session")).toHaveLength(1));
      const pending = fixture.broker.list("root-session")[0]!;
      expect(pending.kind).toBe("cross_provider_spawn");
      expect(pending.crossProvider).toMatchObject({ provider: "openai", model: "gpt-5.4" });
      fixture.broker.resolve("root-session", pending.requestId, { kind: "denied" });
      expect((await next).kind).toBe("consent_denied");
    } finally { fixture.close(); }
  });
});

describe("consent from settings", () => {
  const second = { ...plan, task: { ...plan.task, id: "task-two", text: "Another task" } } as ChildExecutionPlan;

  it("grants an allowed provider without asking, even with no client that could answer", async () => {
    const fixture = interactiveFixture({ agents: SETTINGS_CONSENT, answerable: false });
    try {
      const outcome = await authorizeChildExecutionPlan(fixture.session, plan);
      expect(outcome.kind).toBe("granted");
      expect(fixture.broker.list("root-session")).toHaveLength(0);
    } finally { fixture.close(); }
  });

  it("grants unattended workflow and goal runs from settings", async () => {
    for (const unattended of [{ workflow: true }, { goal: true }]) {
      const fixture = interactiveFixture({ agents: SETTINGS_CONSENT, ...unattended });
      try {
        expect((await authorizeChildExecutionPlan(fixture.session, plan)).kind).toBe("granted");
      } finally { fixture.close(); }
    }
  });

  it("covers a fresh message to an existing child without asking", async () => {
    const fixture = interactiveFixture({ agents: SETTINGS_CONSENT });
    try {
      expect((await authorizeChildExecutionPlan(fixture.session, plan, { fresh: true })).kind).toBe("granted");
      expect(fixture.broker.list("root-session")).toHaveLength(0);
    } finally { fixture.close(); }
  });

  it("covers a nested child's spawn without asking", async () => {
    const fixture = interactiveFixture({ agents: SETTINGS_CONSENT });
    const child = childOf(fixture);
    try {
      expect((await authorizeChildExecutionPlan(child.session, nestedPlan)).kind).toBe("granted");
      expect(fixture.broker.list("root-session")).toHaveLength(0);
    } finally { fixture.close(); }
  });

  it("does not grant a provider the settings no longer allow, also for a message to an existing child", async () => {
    const fixture = interactiveFixture({ agents: { cross_provider_enabled: true, allowed_providers: ["openai"] } });
    try {
      for (const options of [{}, { fresh: true }]) {
        await expect(authorizeChildExecutionPlan(fixture.session, plan, options)).resolves.toMatchObject({
          kind: "consent_unavailable", reason: expect.stringContaining("Provider `deepseek` is not allowed"),
        });
      }
      expect(fixture.broker.list("root-session")).toHaveLength(0);
    } finally { fixture.close(); }
  });

  it("asks at every spawn when the user opted into it", async () => {
    const fixture = interactiveFixture({ agents: ASK_EACH_SPAWN });
    try {
      const { promise, pending } = await pendingDecision(fixture);
      expect(pending.kind).toBe("cross_provider_spawn");
      expect(fixture.broker.resolve("root-session", pending.requestId, { kind: "denied" })).toBe(true);
      expect(await promise).toMatchObject({ kind: "consent_denied" });
    } finally { fixture.close(); }
  });

  it("asks the user again after a child hits a funds stop", async () => {
    const fixture = interactiveFixture({ agents: SETTINGS_CONSENT });
    try {
      expect((await authorizeChildExecutionPlan(fixture.session, plan)).kind).toBe("granted");
      fixture.emit(fundsNotice("/root/worker"));
      const { promise, pending } = await pendingDecision(fixture, second);
      expect(pending.kind).toBe("cross_provider_spawn");
      expect(fixture.broker.resolve("root-session", pending.requestId, { kind: "denied" })).toBe(true);
      expect(await promise).toMatchObject({ kind: "consent_denied" });
    } finally { fixture.close(); }
  });

  it("asks again after a nested child's funds stop and journals that stop with the owner", async () => {
    const fixture = interactiveFixture({ agents: SETTINGS_CONSENT, journal: [] });
    const child = childOf(fixture);
    try {
      expect((await authorizeChildExecutionPlan(child.session, nestedPlan)).kind).toBe("granted");
      // run-agent emits a grandchild's notice on its parent, the child.
      const notice = fundsNotice("/root/worker/researcher");
      child.emit(notice);
      expect(journaledFundsNotices(fixture.journal)).toEqual([
        { type: "event_msg", payload: expect.objectContaining({ msg: notice.msg }) },
      ]);
      const next = authorizeChildExecutionPlan(child.session, { ...nestedPlan,
        task: { ...nestedPlan.task, id: "grandchild-2" } });
      await vi.waitFor(() => expect(fixture.broker.list("root-session")).toHaveLength(1));
      const pending = fixture.broker.list("root-session")[0]!;
      expect(pending.kind).toBe("cross_provider_spawn");
      fixture.broker.resolve("root-session", pending.requestId, { kind: "denied" });
      expect((await next).kind).toBe("consent_denied");
    } finally { fixture.close(); }
  });

  it("journals a nested funds stop once for a workflow owner, which also watches its own log", async () => {
    const fixture = interactiveFixture({ agents: SETTINGS_CONSENT, workflow: true, journal: [] });
    const child = childOf(fixture);
    try {
      child.emit(fundsNotice("/root/worker/researcher"));
      expect(journaledFundsNotices(fixture.journal)).toHaveLength(1);
      await expect(authorizeChildExecutionPlan(child.session, nestedPlan)).resolves
        .toMatchObject({ kind: "consent_unavailable" });
    } finally { fixture.close(); }
  });

  it.each([{ workflow: true }, { goal: true }, { nonInteractive: true }, { autonomousTick: true },
    { answerable: false }])(
    "refuses a run nobody can answer after a funds stop instead of granting it: %j", async (options) => {
      const fixture = interactiveFixture({ agents: SETTINGS_CONSENT, journal: [], ...options });
      try {
        expect((await authorizeChildExecutionPlan(fixture.session, plan)).kind).toBe("granted");
        fixture.emitDurable(fundsNotice("/root/worker"));
        await expect(authorizeChildExecutionPlan(fixture.session, second)).resolves
          .toMatchObject({ kind: "consent_unavailable" });
        expect(fixture.broker.list("root-session")).toHaveLength(0);
      } finally { fixture.close(); }
    },
  );

  it.each([
    ["a direct child's", (fixture: ReturnType<typeof interactiveFixture>) => {
      fixture.emitDurable(fundsNotice("/root/worker"));
    }],
    ["a nested child's", (fixture: ReturnType<typeof interactiveFixture>) => {
      childOf(fixture).emit(fundsNotice("/root/worker/researcher"));
    }],
  ] as const)("keeps settings consent off after a restart once %s funds stop is journaled", async (_label, stop) => {
    const first = interactiveFixture({ agents: SETTINGS_CONSENT, journal: [] });
    try {
      expect((await authorizeChildExecutionPlan(first.session, plan)).kind).toBe("granted");
      stop(first);
    } finally { first.close(); }
    // After a daemon restart a new broker registers the restored owner, which
    // shares only its journal with the first run.
    const restored = interactiveFixture({ agents: SETTINGS_CONSENT, journal: first.journal });
    try {
      const { promise, pending } = await pendingDecision(restored, second);
      expect(pending.kind).toBe("cross_provider_spawn");
      restored.broker.resolve("root-session", pending.requestId, { kind: "denied" });
      expect((await promise).kind).toBe("consent_denied");
    } finally { restored.close(); }
    // A turn resumed with no client that can answer is refused, not granted.
    const resumed = interactiveFixture({ agents: SETTINGS_CONSENT, journal: first.journal, answerable: false });
    try {
      await expect(authorizeChildExecutionPlan(resumed.session, second)).resolves
        .toMatchObject({ kind: "consent_unavailable" });
    } finally { resumed.close(); }
  });

  it("asks when the owner's journal cannot be read", async () => {
    const fixture = interactiveFixture({ agents: SETTINGS_CONSENT, journal: [] });
    Object.assign(fixture.session, { rolloutStore: { readAll: () => { throw new Error("journal unavailable"); } } });
    try {
      const { promise, pending } = await pendingDecision(fixture);
      expect(pending.kind).toBe("cross_provider_spawn");
      fixture.broker.resolve("root-session", pending.requestId, { kind: "denied" });
      expect((await promise).kind).toBe("consent_denied");
    } finally { fixture.close(); }
  });

  it("does not treat a disabled feature as consent", async () => {
    const fixture = interactiveFixture({ agents: { cross_provider_enabled: false, allowed_providers: ["deepseek"] } });
    try {
      const { promise, pending } = await pendingDecision(fixture);
      expect(pending.kind).toBe("cross_provider_spawn");
      expect(fixture.broker.resolve("root-session", pending.requestId, { kind: "denied" })).toBe(true);
      expect(await promise).toMatchObject({ kind: "consent_denied" });
    } finally { fixture.close(); }
  });
});
