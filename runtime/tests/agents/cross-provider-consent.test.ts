import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildCrossProviderDisclosure,
  consentGrantCoversPlan,
  withChildConsentGrant,
  authorizeChildExecutionPlan,
  assertChildExecutionPlan,
  createChildExecutionPlan,
  type ChildExecutionPlan,
} from "../../src/agents/cross-provider.js";
import { LiveApprovalBroker } from "../../src/app-server/live-approval-broker.js";
import { ConfigStore } from "../../src/config/store.js";
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

function interactiveFixture(options: { answerable?: boolean; nonInteractive?: boolean; workflow?: boolean; goal?: boolean; autonomousTick?: boolean; activeTurnId?: string; agents?: Record<string, unknown>; journal?: unknown[];
  /** The session's own config, read from disk; `agents` is then unused. */
  configStore?: ConfigStore; conversationId?: string; broker?: LiveApprovalBroker } = {}) {
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
    conversationId: options.conversationId ?? "root-session",
    services: { runtimeOptions: { nonInteractive: options.nonInteractive === true },
      ...(options.configStore !== undefined ? { configStore: options.configStore } : {}) },
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
  const broker = options.broker ?? new LiveApprovalBroker({ canAnswerCrossProviderConsent: () => answerable });
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

/** A managed child: its requests go through the agenc route to deepseek. */
const managedPlan = { ...plan, route: { provider: "agenc", model: "agenc" },
  destination: { ...plan.destination, authProfile: "managed", billingSource: "managed" } } as ChildExecutionPlan;

/** A child on openai, which ASK_EACH_SPAWN and SETTINGS_CONSENT do not allow. */
const openaiPlan = { ...plan, route: { provider: "openai", model: "gpt-5.4" },
  destination: { ...plan.destination, provider: "openai", model: "gpt-5.4",
    endpoint: "https://api.openai.com/v1" } } as ChildExecutionPlan;

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
    const fixture = interactiveFixture({ agents: { ...ASK_EACH_SPAWN, allowed_providers: ["deepseek", "openai"] } });
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

  it("does not grant a managed child whose route provider the settings no longer allow", async () => {
    // Its requests go through agenc to the destination, so dispatch needs
    // both allowed. A message to it reuses the plan made when both were.
    const both = interactiveFixture({ agents: { ...SETTINGS_CONSENT, allowed_providers: ["agenc", "deepseek"] } });
    try {
      expect((await authorizeChildExecutionPlan(both.session, managedPlan, { fresh: true })).kind).toBe("granted");
    } finally { both.close(); }
    const fixture = interactiveFixture({ agents: SETTINGS_CONSENT });
    try {
      for (const options of [{}, { fresh: true }]) {
        await expect(authorizeChildExecutionPlan(fixture.session, managedPlan, options)).resolves.toMatchObject({
          kind: "consent_unavailable", reason: expect.stringContaining("Provider `agenc` is not allowed"),
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

  it.each([
    ["after a funds stop", SETTINGS_CONSENT, true],
    ["when the user asks at each spawn", ASK_EACH_SPAWN, false],
  ] as const)("does not ask about a provider the settings do not allow %s", async (_label, agents, fundsStop) => {
    const fixture = interactiveFixture({ agents });
    try {
      if (fundsStop) fixture.emit(fundsNotice("/root/worker"));
      // Existing children whose plans the settings no longer allow: approving
      // a card for them would fail at dispatch.
      for (const [task, provider] of [[openaiPlan, "openai"], [managedPlan, "agenc"]] as const) {
        await expect(authorizeChildExecutionPlan(fixture.session, task, { fresh: true })).resolves.toMatchObject({
          kind: "consent_unavailable", reason: expect.stringContaining(`Provider \`${provider}\` is not allowed`),
        });
      }
      expect(fixture.broker.list("root-session")).toHaveLength(0);
    } finally { fixture.close(); }
  });

  it("does not treat a disabled feature as consent, and does not ask either", async () => {
    const fixture = interactiveFixture({ agents: { cross_provider_enabled: false, allowed_providers: ["deepseek"] } });
    try {
      await expect(authorizeChildExecutionPlan(fixture.session, plan)).resolves.toMatchObject({
        kind: "consent_unavailable", reason: expect.stringContaining("Cross-provider subagents are off"),
      });
      expect(fixture.broker.list("root-session")).toHaveLength(0);
    } finally { fixture.close(); }
  });
});

/** An `[agents]` section of config.toml. */
function agentsToml(enabled: boolean, allowed: readonly string[], askEachSpawn = false): string[] {
  return ["[agents]", `cross_provider_enabled = ${enabled}`, `allowed_providers = ${JSON.stringify(allowed)}`,
    ...(askEachSpawn ? ["cross_provider_ask_each_spawn = true"] : [])];
}

/** The same settings as the daemon's own view of user config. */
function agentsView(enabled: boolean, allowed: readonly string[], askEachSpawn = false) {
  return { cross_provider_enabled: enabled, allowed_providers: allowed,
    ...(askEachSpawn ? { cross_provider_ask_each_spawn: true } : {}) };
}

/**
 * A session's own ConfigStore over a user config.toml, read as a daemon session
 * reads it, optionally with an explicit `--config` file.
 */
async function openSettings(user: readonly string[], explicit?: readonly string[]) {
  const home = mkdtempSync(join(tmpdir(), "agenc-cross-provider-settings-"));
  const write = (path: string, lines: readonly string[]) =>
    writeFileSync(path, ["config_version = 2", ...lines, ""].join("\n"));
  const userConfig = join(home, "config.toml");
  const explicitConfig = join(home, "explicit.toml");
  write(userConfig, user);
  if (explicit !== undefined) write(explicitConfig, explicit);
  const store = new ConfigStore({ home, env: { AGENC_HOME: home, HOME: home }, cwd: home,
    managedConfigPath: join(home, "missing-managed.toml"), managedDropInDir: join(home, "missing-managed.d"),
    ...(explicit !== undefined ? { flagConfigPath: explicitConfig } : {}) });
  await store.reload();
  return { store, home, explicitConfig,
    /** What Desktop's save does: `agenc config set` writes user config. */
    save: (lines: readonly string[]) => write(userConfig, lines),
    dispose: () => rmSync(home, { recursive: true, force: true }) };
}

// `daemon.reload` runs `refreshCrossProviderPolicy` on the broker every
// daemon session registers with.
describe("settings changed while a session is open", () => {
  const second = { ...plan, task: { ...plan.task, id: "task-two", text: "Another task" } } as ChildExecutionPlan;
  const third = { ...plan, task: { ...plan.task, id: "task-three", text: "A third task" } } as ChildExecutionPlan;

  it("stops granting from settings after the daemon reload that follows turning the feature off", async () => {
    const settings = await openSettings(['model = "grok-3"', ...agentsToml(true, ["deepseek"])]);
    const fixture = interactiveFixture({ configStore: settings.store });
    try {
      expect((await authorizeChildExecutionPlan(fixture.session, plan)).kind).toBe("granted");
      // The same save also changed the model.
      settings.save(['model = "grok-4"', ...agentsToml(false, ["deepseek"])]);
      // Until the daemon reloads, the open session keeps what it read.
      expect((await authorizeChildExecutionPlan(fixture.session, second)).kind).toBe("granted");
      await expect(fixture.broker.refreshCrossProviderPolicy()).resolves.toEqual({ changed: ["root-session"], failed: [] });
      for (const options of [{}, { fresh: true }]) {
        await expect(authorizeChildExecutionPlan(fixture.session, third, options)).resolves.toMatchObject({
          kind: "consent_unavailable", reason: expect.stringContaining("Cross-provider subagents are off"),
        });
      }
      expect(fixture.broker.list("root-session")).toHaveLength(0);
      expect(settings.store.current().model).toBe("grok-3");
    } finally { fixture.close(); settings.dispose(); }
  });

  it("retires Allow for session when the settings change, and refuses a removed provider without asking", async () => {
    const settings = await openSettings(agentsToml(true, ["deepseek", "openai"], true));
    const fixture = interactiveFixture({ configStore: settings.store });
    try {
      const first = await pendingDecision(fixture);
      fixture.broker.resolve("root-session", first.pending.requestId, { kind: "approved_for_session" },
        { approvalKind: "cross_provider_spawn" });
      expect((await first.promise).kind).toBe("granted");
      expect((await authorizeChildExecutionPlan(fixture.session, second)).kind).toBe("granted");
      expect(fixture.broker.list("root-session")).toHaveLength(0);
      // The user unchecks openai. deepseek stays allowed, but the grant
      // was given under the earlier settings.
      settings.save(agentsToml(true, ["deepseek"], true));
      await expect(fixture.broker.refreshCrossProviderPolicy()).resolves.toEqual({ changed: ["root-session"], failed: [] });
      const again = await pendingDecision(fixture, third);
      expect(again.pending.crossProvider).toMatchObject({ provider: "deepseek", taskId: "task-three" });
      fixture.broker.resolve("root-session", again.pending.requestId, { kind: "denied" });
      expect((await again.promise).kind).toBe("consent_denied");
      await expect(authorizeChildExecutionPlan(fixture.session, openaiPlan, { fresh: true })).resolves.toMatchObject({
        kind: "consent_unavailable", reason: expect.stringContaining("Provider `openai` is not allowed"),
      });
      expect(fixture.broker.list("root-session")).toHaveLength(0);
    } finally { fixture.close(); settings.dispose(); }
  });

  it("grants from settings after the daemon reload that follows turning the feature on", async () => {
    const settings = await openSettings(agentsToml(false, []));
    const fixture = interactiveFixture({ configStore: settings.store, answerable: false });
    try {
      await expect(authorizeChildExecutionPlan(fixture.session, plan)).resolves.toMatchObject({
        kind: "consent_unavailable", reason: expect.stringContaining("Cross-provider subagents are off"),
      });
      settings.save(agentsToml(true, ["deepseek"]));
      await expect(fixture.broker.refreshCrossProviderPolicy()).resolves.toEqual({ changed: ["root-session"], failed: [] });
      expect((await authorizeChildExecutionPlan(fixture.session, plan)).kind).toBe("granted");
      expect(fixture.broker.list("root-session")).toHaveLength(0);
    } finally { fixture.close(); settings.dispose(); }
  });

  it("refuses at dispatch a child plan granted under the earlier settings", async () => {
    const settings = await openSettings(agentsToml(true, ["deepseek"]));
    const fixture = interactiveFixture({ configStore: settings.store });
    Object.assign(fixture.session, {
      modelInfo: { slug: "grok-4.6", provider: "grok" },
      providerService: { current: () => ({ provider: "grok", model: "grok-4.6" }) },
      sessionConfiguration: { cwd: settings.home },
    });
    try {
      const proposed = await createChildExecutionPlan({
        session: fixture.session, selection: { provider: "deepseek", model: "deepseek-v4-pro" },
        modelInfo: { slug: "deepseek-v4-pro", provider: "deepseek", supportsToolUse: true } as Session["modelInfo"],
        parentPath: "/root", taskId: "spawn-plan", taskName: "worker", taskText: "inspect",
        toolFree: false, forkedHistory: false,
      });
      const granted = await authorizeChildExecutionPlan(fixture.session, proposed);
      if (granted.kind !== "granted") throw new Error(`fixture spawn was not granted: ${granted.reason}`);
      await expect(assertChildExecutionPlan(fixture.session, granted.plan)).resolves.toBeUndefined();
      settings.save(agentsToml(false, ["deepseek"]));
      await fixture.broker.refreshCrossProviderPolicy();
      await expect(assertChildExecutionPlan(fixture.session, granted.plan)).rejects.toThrow(/policy changed/u);
    } finally { fixture.close(); settings.dispose(); }
  });

  it("reaches workflow and background sessions, and turns off a session that cannot read its settings", async () => {
    const broker = new LiveApprovalBroker({ canAnswerCrossProviderConsent: () => false });
    const workflowSettings = await openSettings(agentsToml(true, ["deepseek"]));
    // A background run started with an explicit --config file, deleted later.
    const backgroundSettings = await openSettings([], agentsToml(true, ["deepseek"]));
    const workflow = interactiveFixture({ conversationId: "workflow-run", workflow: true, broker,
      configStore: workflowSettings.store });
    const background = interactiveFixture({ conversationId: "background-run", nonInteractive: true, broker,
      configStore: backgroundSettings.store });
    try {
      expect((await authorizeChildExecutionPlan(background.session, plan)).kind).toBe("granted");
      workflowSettings.save(agentsToml(false, ["deepseek"]));
      rmSync(backgroundSettings.explicitConfig);
      // The daemon's own view before and after the save.
      await expect(broker.refreshCrossProviderPolicy({
        previous: agentsView(true, ["deepseek"]), next: agentsView(false, ["deepseek"]) }))
        .resolves.toEqual({
          changed: ["workflow-run"],
          failed: [{ sessionId: "background-run", reason: expect.stringContaining("explicit config file does not exist") }],
        });
      for (const session of [workflow.session, background.session]) {
        await expect(authorizeChildExecutionPlan(session, second)).resolves.toMatchObject({
          kind: "consent_unavailable", reason: expect.stringContaining("Cross-provider subagents are off"),
        });
      }
    } finally {
      workflow.close();
      background.close();
      workflowSettings.dispose();
      backgroundSettings.dispose();
    }
  });

  it("names every session that shares a store, when its settings change and when they cannot be read", async () => {
    const broker = new LiveApprovalBroker({ canAnswerCrossProviderConsent: () => false });
    const settings = await openSettings([], agentsToml(true, ["deepseek"]));
    const firstRun = interactiveFixture({ conversationId: "first-run", nonInteractive: true, broker, configStore: settings.store });
    const secondRun = interactiveFixture({ conversationId: "second-run", nonInteractive: true, broker, configStore: settings.store });
    const writeExplicit = (lines: readonly string[]) =>
      writeFileSync(settings.explicitConfig, ["config_version = 2", ...lines, ""].join("\n"));
    try {
      // The user adds openai.
      writeExplicit(agentsToml(true, ["deepseek", "openai"]));
      await expect(broker.refreshCrossProviderPolicy({
        previous: agentsView(true, ["deepseek"]), next: agentsView(true, ["deepseek", "openai"]) }))
        .resolves.toEqual({ changed: ["first-run", "second-run"], failed: [] });
      // The user removes it again, and neither session can read its settings.
      rmSync(settings.explicitConfig);
      await expect(broker.refreshCrossProviderPolicy({
        previous: agentsView(true, ["deepseek", "openai"]), next: agentsView(true, ["deepseek"]) }))
        .resolves.toEqual({ changed: [], failed: [
          { sessionId: "first-run", reason: expect.stringContaining("explicit config file does not exist") },
          { sessionId: "second-run", reason: expect.stringContaining("explicit config file does not exist") },
        ] });
      expect(settings.store.current().agents?.allowed_providers).toEqual(["deepseek"]);
    } finally {
      firstRun.close();
      secondRun.close();
      settings.dispose();
    }
  });

  it("takes from a session whose workspace blocks its config load what the save took away from the daemon's settings", async () => {
    // Nothing protects .mcp.json: the model, `claude mcp add -s project` or a
    // git pull can write it, and it makes the session's config load fail.
    const root = mkdtempSync(join(tmpdir(), "agenc-cross-provider-workspace-"));
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, ".git"), { recursive: true });
    const save = (lines: readonly string[]) =>
      writeFileSync(join(home, "config.toml"), ["config_version = 2", ...lines, ""].join("\n"));
    save(agentsToml(true, ["deepseek", "openai"]));
    const store = new ConfigStore({ home, env: { AGENC_HOME: home, HOME: home }, cwd: project,
      managedConfigPath: join(root, "managed", "config.toml"), managedDropInDir: join(root, "managed", "config.d") });
    await store.reload();
    const fixture = interactiveFixture({ configStore: store, answerable: false });
    const grokPlan = { ...plan, route: { provider: "grok", model: "grok-4.6" },
      task: { ...plan.task, id: "grok-task" },
      destination: { ...plan.destination, provider: "grok", model: "grok-4.6", endpoint: "https://api.x.ai/v1" } } as ChildExecutionPlan;
    try {
      expect((await authorizeChildExecutionPlan(fixture.session, openaiPlan)).kind).toBe("granted");
      writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
      // Desktop's save removes openai and adds grok.
      save(agentsToml(true, ["deepseek", "grok"]));
      await expect(fixture.broker.refreshCrossProviderPolicy({
        previous: agentsView(true, ["deepseek", "openai"]), next: agentsView(true, ["deepseek", "grok"]),
      })).resolves.toEqual({
        changed: [],
        failed: [{ sessionId: "root-session", reason: expect.stringContaining("Retired configuration input detected") }],
      });
      expect(store.current().agents).toEqual({
        cross_provider_enabled: true, allowed_providers: ["deepseek"], cross_provider_ask_each_spawn: false,
      });
      expect((await authorizeChildExecutionPlan(fixture.session, second)).kind).toBe("granted");
      // The removed provider stops, and the added one is not gained.
      for (const [task, provider] of [[openaiPlan, "openai"], [grokPlan, "grok"]] as const) {
        await expect(authorizeChildExecutionPlan(fixture.session, task, { fresh: true })).resolves.toMatchObject({
          kind: "consent_unavailable", reason: expect.stringContaining(`Provider \`${provider}\` is not allowed`),
        });
      }
      // The next save asks at each spawn. This session asks too, and here
      // nobody can answer.
      save(agentsToml(true, ["deepseek", "grok"], true));
      const askEachSpawn = { cross_provider_enabled: true, allowed_providers: ["deepseek", "grok"], cross_provider_ask_each_spawn: true };
      expect((await fixture.broker.refreshCrossProviderPolicy({
        previous: agentsView(true, ["deepseek", "grok"]), next: askEachSpawn })).failed).toHaveLength(1);
      await expect(authorizeChildExecutionPlan(fixture.session, third)).resolves.toMatchObject({
        kind: "consent_unavailable", reason: expect.stringContaining("No attached consent-capable client"),
      });
      // Once the workspace no longer blocks the read, the session takes its
      // own settings again.
      rmSync(join(project, ".mcp.json"));
      await expect(fixture.broker.refreshCrossProviderPolicy({ previous: askEachSpawn, next: askEachSpawn }))
        .resolves.toEqual({ changed: ["root-session"], failed: [] });
      expect(store.current().agents).toEqual(askEachSpawn);
    } finally {
      fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps what a session's own --config file allows when it cannot read its settings after a save that took nothing away", async () => {
    // An `agenc -p` run with its own --config file. User config, which the
    // daemon reads, never turned cross-provider subagents on.
    const root = mkdtempSync(join(tmpdir(), "agenc-cross-provider-explicit-"));
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, ".git"), { recursive: true });
    const write = (path: string, lines: readonly string[]) =>
      writeFileSync(path, ["config_version = 2", ...lines, ""].join("\n"));
    write(join(home, "config.toml"), ['model = "grok-3"']);
    write(join(home, "run.toml"), agentsToml(true, ["openai"]));
    const store = new ConfigStore({ home, env: { AGENC_HOME: home, HOME: home }, cwd: project,
      flagConfigPath: join(home, "run.toml"),
      managedConfigPath: join(root, "managed", "config.toml"), managedDropInDir: join(root, "managed", "config.d") });
    await store.reload();
    const fixture = interactiveFixture({ conversationId: "ci-run", nonInteractive: true, configStore: store });
    // What a running child listens to.
    const heard = vi.fn();
    store.subscribe(heard, { sections: ["agents"] });
    try {
      expect((await authorizeChildExecutionPlan(fixture.session, openaiPlan)).kind).toBe("granted");
      // The workspace now blocks its config load, and the user changes only
      // the default model in Desktop.
      writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
      write(join(home, "config.toml"), ['model = "grok-4"']);
      const daemonView = agentsView(false, []);
      await expect(fixture.broker.refreshCrossProviderPolicy({ previous: daemonView, next: daemonView })).resolves.toEqual({
        changed: [],
        failed: [{ sessionId: "ci-run", reason: expect.stringContaining("Retired configuration input detected") }],
      });
      expect(store.current().agents).toEqual({
        cross_provider_enabled: true, allowed_providers: ["openai"], cross_provider_ask_each_spawn: false,
      });
      expect(heard).not.toHaveBeenCalled();
      const next = { ...openaiPlan, task: { ...openaiPlan.task, id: "openai-two" } } as ChildExecutionPlan;
      expect((await authorizeChildExecutionPlan(fixture.session, next)).kind).toBe("granted");
    } finally {
      fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not stop a busy session's child for a save that took nothing away, and says its read ran out of time", async () => {
    const broker = new LiveApprovalBroker({ canAnswerCrossProviderConsent: () => false, crossProviderRefreshTimeoutMs: 100 });
    // A run started with its own --config file. User config never turned
    // cross-provider subagents on.
    const settings = await openSettings(['model = "grok-3"'], agentsToml(true, ["deepseek"]));
    const fixture = interactiveFixture({ conversationId: "explicit-run", nonInteractive: true, broker,
      configStore: settings.store });
    Object.assign(fixture.session, {
      modelInfo: { slug: "grok-4.6", provider: "grok" },
      providerService: { current: () => ({ provider: "grok", model: "grok-4.6" }) },
      sessionConfiguration: { cwd: settings.home },
    });
    // What a running child listens to.
    const heard = vi.fn();
    settings.store.subscribe(heard, { sections: ["agents"] });
    let held: Awaited<ReturnType<ConfigStore["prepareReload"]>> | undefined;
    try {
      const proposed = await createChildExecutionPlan({
        session: fixture.session, selection: { provider: "deepseek", model: "deepseek-v4-pro" },
        modelInfo: { slug: "deepseek-v4-pro", provider: "deepseek", supportsToolUse: true } as Session["modelInfo"],
        parentPath: "/root", taskId: "running-child", taskName: "worker", taskText: "inspect",
        toolFree: false, forkedHistory: false,
      });
      const granted = await authorizeChildExecutionPlan(fixture.session, proposed);
      if (granted.kind !== "granted") throw new Error(`fixture spawn was not granted: ${granted.reason}`);
      // Another client's config apply holds the session's config while the
      // user changes only the model and Desktop reloads the daemon.
      held = await settings.store.prepareReload();
      settings.save(['model = "grok-4"']);
      const daemonView = agentsView(false, []);
      await expect(broker.refreshCrossProviderPolicy({ previous: daemonView, next: daemonView })).resolves.toEqual({
        changed: [],
        failed: [{ sessionId: "explicit-run", reason: "Reading its settings took longer than 100 ms.", timedOut: true }],
      });
      // The child's plan still holds, and nothing told it to stop.
      expect(heard).not.toHaveBeenCalled();
      await expect(assertChildExecutionPlan(fixture.session, granted.plan)).resolves.toBeUndefined();
      // Once the config is free, the read that ran out of time finds nothing
      // to change.
      held.rollback();
      held.settle();
      await expect(settings.store.reloadAgentsSection()).resolves.toBe(false);
      expect(heard).not.toHaveBeenCalled();
      expect(settings.store.current().agents).toMatchObject({ cross_provider_enabled: true, allowed_providers: ["deepseek"] });
    } finally {
      if (held !== undefined && !held.settled) {
        held.rollback();
        held.settle();
      }
      fixture.close();
      settings.dispose();
    }
  });

  it("still takes a provider the save removed from a session that cannot read its settings, and keeps what only its own settings allow", async () => {
    // User config allows deepseek and openai. The run's own --config file
    // allows grok as well.
    const settings = await openSettings(agentsToml(true, ["deepseek", "openai"]),
      agentsToml(true, ["deepseek", "openai", "grok"]));
    const fixture = interactiveFixture({ conversationId: "explicit-run", nonInteractive: true,
      configStore: settings.store, answerable: false });
    // A child running on openai stops once openai is no longer allowed.
    const openaiChild = new AbortController();
    settings.store.subscribe((config) => {
      if (!(config.agents?.allowed_providers ?? []).includes("openai")) openaiChild.abort();
    }, { sections: ["agents"] });
    try {
      // The user unchecks openai, and the run's own file cannot be read now.
      settings.save(agentsToml(true, ["deepseek"]));
      rmSync(settings.explicitConfig);
      await expect(fixture.broker.refreshCrossProviderPolicy({
        previous: agentsView(true, ["deepseek", "openai"]), next: agentsView(true, ["deepseek"]),
      })).resolves.toEqual({
        changed: [],
        failed: [{ sessionId: "explicit-run", reason: expect.stringContaining("explicit config file does not exist") }],
      });
      expect(settings.store.current().agents).toEqual({
        cross_provider_enabled: true, allowed_providers: ["deepseek", "grok"], cross_provider_ask_each_spawn: false,
      });
      expect(openaiChild.signal.aborted).toBe(true);
      await expect(authorizeChildExecutionPlan(fixture.session, openaiPlan, { fresh: true })).resolves.toMatchObject({
        kind: "consent_unavailable", reason: expect.stringContaining("Provider `openai` is not allowed"),
      });
      expect((await authorizeChildExecutionPlan(fixture.session, plan)).kind).toBe("granted");
      // The next save turns the feature off, which reaches it too.
      settings.save(agentsToml(false, ["deepseek"]));
      await expect(fixture.broker.refreshCrossProviderPolicy({
        previous: agentsView(true, ["deepseek"]), next: agentsView(false, ["deepseek"]),
      })).resolves.toMatchObject({ changed: [], failed: [{ sessionId: "explicit-run" }] });
      await expect(authorizeChildExecutionPlan(fixture.session, second)).resolves.toMatchObject({
        kind: "consent_unavailable", reason: expect.stringContaining("Cross-provider subagents are off"),
      });
    } finally { fixture.close(); settings.dispose(); }
  });

  it("reports why a session could not read its settings on one plain line, without format characters", async () => {
    const settings = await openSettings(agentsToml(true, ["deepseek"]));
    const fixture = interactiveFixture({ configStore: settings.store });
    // A project file can supply part of the message. A bidi override can
    // reorder the terminal line, and an invisible mark can split a secret.
    const secret = `sk-${"a".repeat(12)}‎${"b".repeat(12)}`;
    vi.spyOn(settings.store, "reloadAgentsSection").mockRejectedValue(new Error(
      `invalid TOML at /work/‮evil‬.toml\nline 2:⁦ model = "${secret}"⁩\u0007`));
    try {
      await expect(fixture.broker.refreshCrossProviderPolicy()).resolves.toEqual({
        changed: [],
        failed: [{ sessionId: "root-session", reason: 'invalid TOML at /work/evil.toml line 2: model = "[REDACTED_SECRET]"' }],
      });
    } finally { fixture.close(); settings.dispose(); }
  });

  it("reads again the settings of a session that registers after a daemon reload began, before its first decision", async () => {
    const failures: unknown[] = [];
    const broker = new LiveApprovalBroker({ canAnswerCrossProviderConsent: () => false,
      onCrossProviderRefreshFailed: (failure) => failures.push(failure) });
    // Both still start (auth, model, replay) when the user saves and the
    // daemon reloads, so the reload does not see them.
    const starting = await openSettings(agentsToml(true, ["deepseek"]));
    const unreadable = await openSettings([], agentsToml(true, ["deepseek"]));
    starting.save(agentsToml(false, ["deepseek"]));
    rmSync(unreadable.explicitConfig);
    await expect(broker.refreshCrossProviderPolicy({
      previous: agentsView(true, ["deepseek"]), next: agentsView(false, ["deepseek"]) }))
      .resolves.toEqual({ changed: [], failed: [] });
    // A session that reads its settings after the reload began needs no second read.
    const fresh = await openSettings(agentsToml(true, ["deepseek"]));
    const freshRead = vi.spyOn(fresh.store, "reloadAgentsSection");
    const late = interactiveFixture({ conversationId: "late-run", nonInteractive: true, broker, configStore: starting.store });
    const narrowed = interactiveFixture({ conversationId: "unreadable-run", nonInteractive: true, broker,
      configStore: unreadable.store });
    const current = interactiveFixture({ conversationId: "fresh-run", nonInteractive: true, broker, configStore: fresh.store });
    try {
      for (const session of [late.session, narrowed.session]) {
        await expect(authorizeChildExecutionPlan(session, plan)).resolves.toMatchObject({
          kind: "consent_unavailable", reason: expect.stringContaining("Cross-provider subagents are off"),
        });
      }
      expect(failures).toEqual([
        { sessionId: "unreadable-run", reason: expect.stringContaining("explicit config file does not exist") },
      ]);
      expect((await authorizeChildExecutionPlan(current.session, plan)).kind).toBe("granted");
      expect(freshRead).not.toHaveBeenCalled();
    } finally {
      late.close();
      narrowed.close();
      current.close();
      for (const settings of [starting, unreadable, fresh]) settings.dispose();
    }
  });

  it("grants nothing for a card that was open across a reload that removed its provider", async () => {
    const settings = await openSettings(agentsToml(true, ["deepseek", "openai"], true));
    const fixture = interactiveFixture({ configStore: settings.store });
    try {
      for (const decision of ["approved", "approved_for_session"] as const) {
        const card = await pendingDecision(fixture);
        // The user unchecks deepseek in Desktop while the card is open.
        settings.save(agentsToml(true, ["openai"], true));
        await expect(fixture.broker.refreshCrossProviderPolicy({
          previous: agentsView(true, ["deepseek", "openai"], true), next: agentsView(true, ["openai"], true),
        })).resolves.toEqual({ changed: ["root-session"], failed: [] });
        expect(fixture.broker.resolve("root-session", card.pending.requestId, { kind: decision },
          { approvalKind: "cross_provider_spawn" })).toBe(true);
        await expect(card.promise).resolves.toMatchObject({
          kind: "consent_unavailable", reason: expect.stringContaining("Provider `deepseek` is not allowed"),
        });
        settings.save(agentsToml(true, ["deepseek", "openai"], true));
        await fixture.broker.refreshCrossProviderPolicy({
          previous: agentsView(true, ["openai"], true), next: agentsView(true, ["deepseek", "openai"], true),
        });
      }
    } finally { fixture.close(); settings.dispose(); }
  });

  it("does not wait on a session whose config is busy: it narrows and reports that session, which reads its settings once free", async () => {
    const broker = new LiveApprovalBroker({ canAnswerCrossProviderConsent: () => false, crossProviderRefreshTimeoutMs: 250 });
    const fast = await openSettings(agentsToml(true, ["deepseek"]));
    const busy = await openSettings(agentsToml(true, ["deepseek"]));
    const fastRun = interactiveFixture({ conversationId: "fast-run", nonInteractive: true, broker, configStore: fast.store });
    const busyRun = interactiveFixture({ conversationId: "busy-run", nonInteractive: true, broker, configStore: busy.store });
    // A config reload of the busy session's own, which read its sources
    // before the save, holds its store.
    const held = await busy.store.prepareReload();
    try {
      for (const settings of [fast, busy]) settings.save(agentsToml(false, ["deepseek"]));
      const refresh = broker.refreshCrossProviderPolicy({
        previous: agentsView(true, ["deepseek"]), next: agentsView(false, ["deepseek"]) });
      const outcome = await Promise.race([refresh,
        new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 5_000))]);
      expect(outcome).toEqual({
        changed: ["fast-run"],
        failed: [{ sessionId: "busy-run", reason: "Reading its settings took longer than 250 ms.", timedOut: true }],
      });
      for (const session of [fastRun.session, busyRun.session]) {
        await expect(authorizeChildExecutionPlan(session, plan)).resolves.toMatchObject({
          kind: "consent_unavailable", reason: expect.stringContaining("Cross-provider subagents are off"),
        });
      }
      // The held reload publishes its older read, which stays narrowed.
      held.commit();
      held.publish();
      held.settle();
      expect(busy.store.current().agents?.cross_provider_enabled).toBe(false);
      // The read that timed out still runs once the store is free. This one
      // queues behind it.
      await expect(busy.store.reloadAgentsSection()).resolves.toBe(false);
      // Its own settings reach it again on the next reload.
      for (const settings of [fast, busy]) settings.save(agentsToml(true, ["deepseek"]));
      await expect(broker.refreshCrossProviderPolicy({
        previous: agentsView(false, ["deepseek"]), next: agentsView(true, ["deepseek"]) }))
        .resolves.toEqual({ changed: ["fast-run", "busy-run"], failed: [] });
      expect((await authorizeChildExecutionPlan(busyRun.session, second)).kind).toBe("granted");
    } finally {
      if (!held.settled) {
        held.rollback();
        held.settle();
      }
      fastRun.close();
      busyRun.close();
      fast.dispose();
      busy.dispose();
    }
  });

  it("refuses a managed child's plan when the settings change while its destination resolves", async () => {
    // run-agent subscribes to setting changes only after this last check, so
    // the check must see a change made during its own awaits.
    const settings = await openSettings(['model_provider = "grok"', 'model = "grok-4.6"',
      ...agentsToml(true, ["agenc", "deepseek"])]);
    let gate: Promise<void> | undefined;
    let arrived!: () => void;
    const atGate = new Promise<void>((resolve) => { arrived = resolve; });
    const fixture = interactiveFixture({ configStore: settings.store, nonInteractive: true, answerable: false });
    Object.assign(fixture.session, {
      modelInfo: { slug: "grok-4.6" },
      sessionConfiguration: { cwd: settings.home, collaborationMode: { model: "grok-4.6" } },
      providerService: {
        current: () => ({ provider: "grok", model: "grok-4.6" }),
        resolveManagedChildDestination: async () => {
          if (gate !== undefined) { arrived(); await gate; }
          return { provider: "deepseek", model: "deepseek-v4-pro" };
        },
        previewChildDestination: async (_selection: unknown, concrete: { provider: string } | undefined) => ({
          endpoint: concrete?.provider === "agenc" ? "https://id.agenc.ag/v1" : "https://api.deepseek.com/v1",
          authProfile: "managed", billingSource: "managed" }),
      },
    });
    Object.assign(fixture.session.services, {
      modelsManager: { tryListModels: () => [{ slug: "grok-4.6" }], listModels: async () => [{ slug: "grok-4.6" }] },
    });
    try {
      const proposed = await createChildExecutionPlan({ session: fixture.session,
        selection: { provider: "agenc", model: "agenc" },
        modelInfo: { slug: "agenc", supportsToolUse: true } as Session["modelInfo"],
        parentPath: "/root", taskId: "managed-task", taskName: "worker", taskText: "inspect",
        toolFree: false, forkedHistory: false });
      const granted = await authorizeChildExecutionPlan(fixture.session, proposed);
      if (granted.kind !== "granted") throw new Error(`fixture spawn was not granted: ${granted.reason}`);
      let release!: () => void;
      gate = new Promise<void>((resolve) => { release = resolve; });
      const check = assertChildExecutionPlan(fixture.session, granted.plan);
      await atGate;
      settings.save(['model_provider = "grok"', 'model = "grok-4.6"', ...agentsToml(false, ["agenc", "deepseek"])]);
      await expect(fixture.broker.refreshCrossProviderPolicy({
        previous: agentsView(true, ["agenc", "deepseek"]), next: agentsView(false, ["agenc", "deepseek"]) }))
        .resolves.toEqual({ changed: ["root-session"], failed: [] });
      release();
      await expect(check).rejects.toThrow(/policy changed/u);
    } finally { fixture.close(); settings.dispose(); }
  });
});
