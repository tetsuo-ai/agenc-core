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

function interactiveFixture(options: { answerable?: boolean; nonInteractive?: boolean; workflow?: boolean; goal?: boolean; autonomousTick?: boolean; activeTurnId?: string } = {}) {
  let stopped = false;
  let answerable = options.answerable !== false;
  const eventListeners = new Set<(event: unknown) => void>();
  const session = {
    conversationId: "root-session",
    services: { runtimeOptions: { nonInteractive: options.nonInteractive === true } },
    abortController: new AbortController(),
    markStoppedByUser: () => { stopped = true; },
    eventLog: { subscribe: (listener: (event: unknown) => void) => {
      eventListeners.add(listener); return () => { eventListeners.delete(listener); };
    } },
    onBeforeDurableClose: () => () => {},
    ...(options.autonomousTick ? { activeTurn: { unsafePeek: () => ({ turnId: "tick" }) }, currentRootHumanTurn: () => null } : {}),
    ...(options.activeTurnId !== undefined ? {
      activeTurn: { unsafePeek: () => ({ turnId: options.activeTurnId }) },
      currentRootHumanTurn: () => ({ turnId: options.activeTurnId }),
    } : {}),
  } as unknown as Session;
  const broker = new LiveApprovalBroker({ canAnswerCrossProviderConsent: () => answerable });
  const close = broker.register(session, { isActive: () => true, workflow: options.workflow === true });
  if (options.goal) restoreSessionGoal(session, { objective: "unattended work", status: "active" } as never);
  return { session, broker, close, stopped: () => stopped, setAnswerable: (value: boolean) => { answerable = value; },
  };
}

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
    "fails immediately when consent is unavailable: %j", async (options) => {
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
