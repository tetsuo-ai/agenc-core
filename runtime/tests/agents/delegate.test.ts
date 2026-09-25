import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("./fork-context.js", () => ({
  forkSubagent: vi.fn(async () => ({
    messages: [{ role: "user", content: "seed prompt" }],
  })),
}));

vi.mock("./run-agent.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../session/event-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session/event-log.js")>()),
  emitWarning: vi.fn(),
}));

import { AgentStatusTracker } from "./status.js";
import { childTerminalOutcome } from "./child-terminal.js";
import { Mailbox } from "./mailbox.js";
import {
  _resetAgentRolesForTesting,
  createAgentRoleWorkspace,
  registerAgentRole,
  resolveAgentRole,
} from "./role.js";
import { delegate } from "./delegate.js";
import { forkSubagent } from "./fork-context.js";
import { runAgent } from "./run-agent.js";
import { AgentControl, MaxDepthExceededError, type LiveAgent } from "./control.js";
import {
  AgentCapacityQueueFullError,
  AgentConcurrencyLimitError,
  AgentPathExistsError,
  AgentRegistry,
} from "./registry.js";
import type { AgentMetadata } from "./registry.js";
import { RolloutStore } from "../session/rollout-store.js";
import { SessionProviderService } from "../session/provider-service.js";
import { createProvider } from "../llm/provider.js";
import { resolveProviderRuntimeRequest } from "../llm/provider-request.js";
import { defaultConfig } from "../config/schema.js";
import { StaticModelsManager } from "../llm/models-manager.js";
import { authorizeChildExecutionPlan, createChildExecutionPlan } from "./cross-provider.js";
import type { Session } from "../session/session.js";
import { EventLog } from "../session/event-log.js";
import {
  computeAgentInvocationEnvelopeDigest,
  createCsvAgentInvocationEnvelope,
} from "../contracts/agent-invocation-envelope.js";

const mockRunAgent = vi.mocked(runAgent);
const mockForkSubagent = vi.mocked(forkSubagent);
const ROLE_WORKSPACE = createAgentRoleWorkspace(process.cwd());

async function grantedTestPlan(parent: Session, pair: { provider: string; model: string },
  modelInfo: Session["modelInfo"], taskText: string, taskId: string, parentPath: string) {
  const ownerSessionId = parent.services.crossProviderConsent?.ownerSessionId ?? parent.conversationId;
  Object.assign(parent.services, { crossProviderConsent: {
    ownerSessionId, sessionEpoch: "delegate-test-human",
    request: async (_session: Session, disclosure: { taskId: string; scopeKey: string; payloadKey: string }) => ({
      kind: "granted" as const,
      grant: { kind: "once" as const, ownerSessionId, sessionEpoch: "delegate-test-human",
        taskId: disclosure.taskId, scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey },
    }),
  } });
  const proposed = await createChildExecutionPlan({ session: parent, selection: pair, modelInfo,
    parentPath, taskId, taskName: "worker", taskText, toolFree: false, forkedHistory: false });
  const authorized = await authorizeChildExecutionPlan(parent, proposed);
  if (authorized.kind !== "granted") throw new Error("fixture consent failed");
  return authorized.plan;
}

function makeLive(
  agentId: string,
  agentPath: string,
  nickname = "alpha",
): LiveAgent {
  const metadata: AgentMetadata = {
    agentId,
    agentPath,
    agentNickname: nickname,
    agentRole: "default",
    agentRoleWorkspaceId: ROLE_WORKSPACE.id,
    depth: 1,
  };
  return {
    agentId,
    agentPath,
    role: resolveAgentRole(ROLE_WORKSPACE, undefined),
    depth: 1,
    nickname,
    status: new AgentStatusTracker(),
    upInbox: new Mailbox({ threadId: agentId }),
    downInbox: new Mailbox({ threadId: `${agentId}-down` }),
    abortController: new AbortController(),
    metadata,
    messages: [],
    memoryEntries: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

function makeParentSession() {
  return {
    conversationId: "parent-session",
    abortController: new AbortController(),
    eventLog: {},
    nextInternalSubId: () => "sub-1",
    snapshotHistoryMessages: () => [],
    sessionConfiguration: { cwd: "/repo" },
    config: { cwd: "/repo" },
    services: { admissionRequired: false },
  };
}

function runResult(result: {
  threadId: string;
  durationMs: number;
  outcome: "completed" | "errored" | "interrupted" | "aborted";
  finalMessage?: string;
  error?: unknown;
}) {
  return (async function* () {
    return result;
  })();
}

function makeRealDelegateHarness(
  label: string,
  configureRoles?: (workspace: ReturnType<typeof createAgentRoleWorkspace>) => void,
) {
  const cwd = mkdtempSync(join(tmpdir(), `agenc-delegate-${label}-`));
  const priorAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = cwd;
  const parentConversationId = `${label}-parent`;
  const rolloutStore = new RolloutStore({
    cwd,
    sessionId: parentConversationId,
    agencVersion: "0.6.0",
    sessionTempRoot: tmpdir(),
    autoStartScheduler: false,
  });
  rolloutStore.open({
    sessionId: parentConversationId,
    timestamp: new Date().toISOString(),
    cwd,
    originator: "delegate-test",
    agencVersion: "0.6.0",
    model: "test-model",
    modelProvider: "test-provider",
  });
  const roleWorkspace = createAgentRoleWorkspace(cwd);
  configureRoles?.(roleWorkspace);
  const parent = {
    ...makeParentSession(),
    conversationId: parentConversationId,
    sessionConfiguration: { cwd },
    config: { cwd },
    roleWorkspace,
    rolloutStore,
    childInboxes: new Map(),
    mailbox: { send: vi.fn() },
    services: { admissionRequired: false },
  };
  const registry = new AgentRegistry();
  const control = new AgentControl({
    session: parent as never,
    registry,
  });
  control.registerSessionRoot(parent.conversationId);
  return {
    cwd,
    parent,
    registry,
    control,
    rolloutStore,
    cleanup: () => {
      rolloutStore.close();
      _resetAgentRolesForTesting();
      if (priorAgencHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = priorAgencHome;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

describe("delegate lifecycle recovery", () => {
  it.each(["spawn", "fork"] as const)("retires a new live slot if caller authority expires during %s setup", async (stage) => {
    const live = makeLive("thread-expired", "/root/implementation/worker");
    let active = true;
    const control = {
      spawn: vi.fn(async () => { if (stage === "spawn") active = false; return live; }),
      shutdown: vi.fn(async () => {}),
    };
    if (stage === "fork") mockForkSubagent.mockImplementationOnce(async () => {
      active = false;
      return { messages: [{ role: "user", content: "seed" }] } as never;
    });
    const runCount = mockRunAgent.mock.calls.length;
    const outcome = await delegate({ parent: makeParentSession() as never, parentPath: "/root/implementation", control: control as never, registry: {} as never, taskPrompt: "go", assertParentSessionActive: () => { if (!active) throw new Error("caller session revoked"); } });
    expect(outcome).toMatchObject({ kind: "rejected", reason: expect.stringContaining("caller session revoked") });
    expect(control.shutdown).toHaveBeenCalledWith(live.agentId, "delegate_fork_failed");
    expect(mockRunAgent.mock.calls).toHaveLength(runCount);
  });

  it("retires a transferred live slot when fork setup fails", async () => {
    const live = makeLive("thread-fork-failure", "/root/fork_failure");
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(),
    };
    mockForkSubagent.mockRejectedValueOnce(new Error("fork context failed"));

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "cannot fork",
    });

    expect(outcome).toMatchObject({
      kind: "rejected",
      code: "AGENT_SPAWN_REJECTED",
      category: "spawn_failed",
      reason: expect.stringContaining("fork context failed"),
    });
    expect(control.shutdown).toHaveBeenCalledWith(
      "thread-fork-failure",
      "delegate_fork_failed",
    );
  });

  it("launches in the background by default", async () => {
    const live = makeLive("thread-bg", "/root/background");
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      markThreadSpawnEdgeClosed: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(),
    };
    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-bg",
        durationMs: 5,
        outcome: "completed",
        finalMessage: "done",
      }),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "run separately",
    });

    expect(outcome.kind).toBe("async_launched");
    if (outcome.kind !== "async_launched") {
      throw new Error("expected async_launched");
    }
    await outcome.thread.join();
    expect(control.shutdown).not.toHaveBeenCalled();
    expect(control.markThreadSpawnEdgeClosed).toHaveBeenCalledWith("thread-bg");
  });

  it.each(["string", "object"] as const)("reads a %s child status after its run", async (shape) => {
    const live = makeLive(`thread-${shape}`, `/root/${shape}`);
    const terminal = childTerminalOutcome({ provider: "fake", model: "fake-model",
      reason: "completed", dispatch: "sent", completedWork: "done" });
    const control = {
      spawn: vi.fn(async () => live), shutdown: vi.fn(async () => {}),
      markThreadSpawnEdgeClosed: vi.fn(async () => {}),
      recordTerminalOutcome: vi.fn(), resumeAgentFromRollout: vi.fn(),
    };
    mockRunAgent.mockImplementationOnce(() => {
      live.status.subject.next((shape === "string" ? "running" : { status: "idle", terminal }) as never);
      return runResult({ threadId: live.agentId, durationMs: 1, outcome: "completed", finalMessage: "done" });
    });
    const outcome = await delegate({ parent: makeParentSession() as never,
      parentPath: "/root", control: control as never, registry: {} as never,
      taskPrompt: "run separately" });
    expect(outcome.kind).toBe("async_launched");
    if (outcome.kind !== "async_launched") throw new Error("expected async launch");
    await outcome.thread.join();
    if (shape === "string") expect(control.recordTerminalOutcome).not.toHaveBeenCalled();
    else expect(control.recordTerminalOutcome).toHaveBeenCalledWith(live.agentId, terminal);
  });

  it("records summary cache params and tool transcript events from async runs", async () => {
    const live = makeLive("thread-summary", "/root/summary");
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(),
    };
    const cacheSafeParams = {
      systemPrompt: "",
      userContext: {},
      systemContext: {},
      toolUseContext: {},
      forkContextMessages: [],
    };
    mockRunAgent.mockImplementationOnce((params) =>
      (async function* () {
        params.onCacheSafeParams?.(cacheSafeParams as never);
        yield {
          kind: "tool_call" as const,
          callId: "call-1",
          toolName: "Read",
          arguments: '{"file_path":"x.ts"}',
        };
        yield {
          kind: "tool_result" as const,
          callId: "call-1",
          toolName: "Read",
          result: "file body",
          isError: false,
        };
        return {
          threadId: "thread-summary",
          durationMs: 5,
          outcome: "completed" as const,
          finalMessage: "done",
        };
      })(),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "run separately",
    });

    expect(outcome.kind).toBe("async_launched");
    if (outcome.kind !== "async_launched") {
      throw new Error("expected async_launched");
    }
    await outcome.thread.join();
    expect(outcome.thread.summaryCacheSafeParams).toBe(cacheSafeParams);
    expect(
      outcome.thread.summaryMessages.map((message) => message.type),
    ).toEqual(["user", "assistant", "user"]);
    expect(outcome.thread.summaryMessages[0]?.message.content).toBe(
      "seed prompt",
    );
    expect(outcome.thread.summaryMessages[1]?.message.content).toEqual([
      expect.objectContaining({
        type: "tool_use",
        id: "call-1",
        input: { file_path: "x.ts" },
      }),
    ]);
    expect(outcome.thread.summaryMessages[2]?.message.content).toEqual([
      expect.objectContaining({
        type: "tool_result",
        tool_use_id: "call-1",
      }),
    ]);
  });

  it("forceSynchronous overrides role-level background mode", async () => {
    const live = {
      ...makeLive("thread-sync", "/root/sync"),
      role: {
        ...resolveAgentRole(ROLE_WORKSPACE, undefined),
        config: { background: true },
      },
    };
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(),
    };
    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-sync",
        durationMs: 5,
        outcome: "completed",
        finalMessage: "done",
      }),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "run inline",
      runInBackground: false,
      forceSynchronous: true,
    });

    expect(outcome.kind).toBe("sync_completed");
    expect(control.shutdown).toHaveBeenCalledWith(
      "thread-sync",
      "delegate_teardown",
    );
  });

  it("passes normalized parent history into forkSubagent for inherited fork modes", async () => {
    const live = makeLive("thread-1", "/root/alpha");
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(),
    };
    const history = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ];

    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-1",
        durationMs: 5,
        outcome: "completed",
        finalMessage: "done",
      }),
    );

    await delegate({
      parent: {
        ...makeParentSession(),
        snapshotHistoryMessages: () => history,
      } as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "inspect history",
      forkMode: { kind: "full_history" },
    });

    expect(mockForkSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentMessages: history,
        mode: { kind: "full_history" },
      }),
    );
  });

  it("passes parent history into last_n_turns forks", async () => {
    const live = makeLive("thread-2", "/root/bravo");
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(),
    };
    const history = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ];

    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-2",
        durationMs: 5,
        outcome: "completed",
        finalMessage: "done",
      }),
    );

    await delegate({
      parent: {
        ...makeParentSession(),
        snapshotHistoryMessages: () => history,
      } as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "slice history",
      forkMode: { kind: "last_n_turns", n: 2 },
    });

    expect(mockForkSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentMessages: history,
        mode: { kind: "last_n_turns", n: 2 },
      }),
    );
  });

  it("rejects worktree isolation without a slug", async () => {
    const control = {
      spawn: vi.fn(),
      shutdown: vi.fn(),
      resumeAgentFromRollout: vi.fn(),
    };

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "fix it",
      isolation: "worktree",
    });

    expect(outcome).toEqual({
      kind: "rejected",
      code: "INVALID_DELEGATE_REQUEST",
      category: "invalid_request",
      reason: "worktree isolation requires a non-empty worktreeSlug",
      effectDisposition: expect.objectContaining({
        disposition: "confirmed_no_effect",
        evidenceRef: "agents.delegate:refused-before-child",
      }),
    });
    expect(control.spawn).not.toHaveBeenCalled();
  });

  it("rejects a malformed invocation envelope before reserving a child slot", async () => {
    const control = {
      spawn: vi.fn(),
      shutdown: vi.fn(),
      resumeAgentFromRollout: vi.fn(),
    };
    const envelope = structuredClone(
      createCsvAgentInvocationEnvelope({
        jobId: "job-1",
        itemId: "item-1",
        rowIndex: 0,
        rowSha256: `sha256:${"d".repeat(64)}`,
        instruction: "Process the value.",
        row: { value: "untrusted" },
      }),
    );
    const runtimePolicy = envelope.runtime_policy[0] as {
      inline_payload: string;
      byte_length: number;
      sha256: `sha256:${string}`;
    };
    runtimePolicy.inline_payload = "forged runtime policy";
    runtimePolicy.byte_length = Buffer.byteLength(runtimePolicy.inline_payload);
    runtimePolicy.sha256 = `sha256:${createHash("sha256")
      .update(runtimePolicy.inline_payload)
      .digest("hex")}`;
    envelope.envelope_digest = computeAgentInvocationEnvelopeDigest({
      version: envelope.version,
      kind: envelope.kind,
      invocation_id: envelope.invocation_id,
      minimum_reader_version: envelope.minimum_reader_version,
      runtime_policy: envelope.runtime_policy,
      task_instructions: envelope.task_instructions,
      untrusted_data: envelope.untrusted_data,
    });

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "CSV job item item-1",
      invocationEnvelope: envelope,
    });

    expect(outcome).toMatchObject({
      kind: "rejected",
      code: "INVALID_DELEGATE_REQUEST",
      category: "invalid_request",
      reason: expect.stringMatching(/canonical runtime-owned policy/u),
    });
    expect(control.spawn).not.toHaveBeenCalled();
    expect(control.shutdown).not.toHaveBeenCalled();
  });

  it("resumes the same live agent after a retryable failure", async () => {
    const live1 = makeLive("thread-1", "/root/alpha");
    const resumedLive = makeLive("thread-1", "/root/alpha");
    const control = {
      spawn: vi.fn(async () => live1),
      shutdown: vi.fn(async () => {}),
      assertAgentMetadataRoleWorkspace: vi.fn(),
      resumeAgentFromRollout: vi.fn(async () => ({
        resumedCount: 1,
        rootLive: resumedLive,
      })),
    };
    const resumeManager = {
      recordFailure: vi.fn(() => ({
        kind: "resume" as const,
        reason: "retry",
      })),
      recordSuccess: vi.fn(),
    };

    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-1",
        durationMs: 10,
        outcome: "errored",
        error: new Error("transient"),
      }),
    );
    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-1",
        durationMs: 12,
        outcome: "completed",
        finalMessage: "done after resume",
      }),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "fix it",
      runInBackground: false,
      resumeManager: resumeManager as never,
    });

    expect(outcome.kind).toBe("sync_completed");
    if (outcome.kind !== "sync_completed") {
      throw new Error("expected sync_completed");
    }

    expect(control.spawn).toHaveBeenCalledTimes(1);
    expect(control.assertAgentMetadataRoleWorkspace).toHaveBeenCalledWith(
      live1.metadata,
    );
    expect(control.shutdown).toHaveBeenCalledWith(
      "thread-1",
      "delegate_resume",
    );
    expect(control.resumeAgentFromRollout).toHaveBeenCalledWith({
      rootThreadId: "thread-1",
      parentPath: "/root",
      metadata: live1.metadata,
    });
    expect(outcome.thread.threadId).toBe("thread-1");
    expect(outcome.thread.live).toBe(resumedLive);
    expect(outcome.result.finalMessage).toBe("done after resume");
    expect(resumeManager.recordFailure).toHaveBeenCalledOnce();
    expect(resumeManager.recordSuccess).toHaveBeenCalledWith("thread-1");
  });

  it("validates role provenance before mutating retryable resume state", async () => {
    const live = makeLive("thread-provenance", "/root/provenance");
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      assertAgentMetadataRoleWorkspace: vi.fn(() => {
        throw new Error("agent role workspace mismatch");
      }),
      resumeAgentFromRollout: vi.fn(),
    };
    const resumeManager = {
      recordFailure: vi.fn(() => ({
        kind: "resume" as const,
        reason: "retry",
      })),
      recordSuccess: vi.fn(),
    };
    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: live.agentId,
        durationMs: 10,
        outcome: "errored",
        error: new Error("transient"),
      }),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "fix it",
      runInBackground: false,
      resumeManager: resumeManager as never,
    });

    expect(outcome.kind).toBe("sync_completed");
    if (outcome.kind !== "sync_completed") {
      throw new Error("expected sync_completed");
    }
    expect(outcome.result.outcome).toBe("errored");
    expect(control.assertAgentMetadataRoleWorkspace).toHaveBeenCalledWith(
      live.metadata,
    );
    expect(control.shutdown).not.toHaveBeenCalled();
    expect(control.resumeAgentFromRollout).not.toHaveBeenCalled();
  });

  it("restarts with a fresh live handle after a hard failure", async () => {
    const live1 = makeLive("thread-1", "/root/alpha");
    const restartedLive = makeLive("thread-2", "/root/bravo");
    const control = {
      spawn: vi
        .fn(async () => live1)
        .mockImplementationOnce(async () => live1)
        .mockImplementationOnce(async () => restartedLive),
      shutdown: vi.fn(async () => {}),
      assertAgentMetadataRoleWorkspace: vi.fn(),
      resumeAgentFromRollout: vi.fn(async () => ({
        resumedCount: 0,
        rootLive: null,
      })),
    };
    const resumeManager = {
      recordFailure: vi.fn(() => ({
        kind: "restart" as const,
        reason: "hard_error",
      })),
      recordSuccess: vi.fn(),
      transferFailureCount: vi.fn(),
    };

    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-1",
        durationMs: 10,
        outcome: "errored",
        error: new Error("hard fail"),
      }),
    );
    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-2",
        durationMs: 12,
        outcome: "completed",
        finalMessage: "done after restart",
      }),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "fix it",
      runInBackground: false,
      resumeManager: resumeManager as never,
    });

    expect(outcome.kind).toBe("sync_completed");
    if (outcome.kind !== "sync_completed") {
      throw new Error("expected sync_completed");
    }

    expect(control.spawn).toHaveBeenCalledTimes(2);
    expect(control.spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedRoleProvenance: live1.metadata,
      }),
    );
    expect(control.assertAgentMetadataRoleWorkspace).toHaveBeenCalledWith(
      live1.metadata,
    );
    expect(control.shutdown).toHaveBeenCalledWith(
      "thread-1",
      "delegate_restart",
    );
    expect(control.shutdown).toHaveBeenCalledWith(
      "thread-2",
      "delegate_teardown",
    );
    expect(control.resumeAgentFromRollout).not.toHaveBeenCalled();
    expect(outcome.thread.threadId).toBe("thread-2");
    expect(outcome.thread.live).toBe(restartedLive);
    expect(outcome.result.threadId).toBe("thread-2");
    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.finalMessage).toBe("done after restart");
    expect(resumeManager.recordSuccess).toHaveBeenCalledWith("thread-2");
  });

  it.each(["ready", "credential revoked", "policy revoked"] as const)(
    "retains the durable provider pair through a real hard restart when %s",
    async (state) => {
      mockRunAgent.mockReset();
      const harness = makeRealDelegateHarness(`provider-restart-${state.replaceAll(" ", "-")}`);
      let key: string | undefined = "deepseek-key";
      let enabled = true;
      const config = () => ({
        ...defaultConfig(), model_provider: "grok", model: "grok-4.6",
        agents: { cross_provider_enabled: enabled, allowed_providers: ["deepseek"] },
      });
      const modelsManager = new StaticModelsManager({ config: config(), fallbackProvider: "grok" });
      const readSavedApiKey = vi.fn(async () => key);
      const providerService = new SessionProviderService({
        initialProvider: createProvider("grok", { model: "grok-4.6", apiKey: "parent-key" }),
        readSavedApiKey,
        resolvePreparationRequest: ({ model }) => ({
          requested: resolveProviderRuntimeRequest({
            provider: "deepseek", model, config: config(), environment: {},
          }).requested,
        }),
      });
      Object.assign(harness.parent, {
        providerService,
        modelInfo: await modelsManager.getModelInfo("grok-4.6"),
        sessionConfiguration: {
          ...harness.parent.sessionConfiguration,
          collaborationMode: { model: "grok-4.6" },
        },
        services: {
          ...harness.parent.services,
          configStore: { current: config },
          modelsManager,
        },
      });
      const pair = { provider: "deepseek", model: "deepseek-v4-pro" };
      const plan = await grantedTestPlan(harness.parent as Session, pair,
        await modelsManager.getModelInfo(pair.model), "inspect", "delegate-restart", "/root");
      const spawnSpy = vi.spyOn(harness.control, "spawn");
      const resumeManager = {
        recordFailure: vi.fn(() => ({ kind: "restart" as const, reason: "hard_error" })),
        recordSuccess: vi.fn(),
        transferFailureCount: vi.fn(),
      };
      mockRunAgent.mockImplementationOnce((params) => {
        if (state === "credential revoked") key = undefined;
        if (state === "policy revoked") enabled = false;
        return runResult({ threadId: params.live.agentId, durationMs: 1, outcome: "errored", error: new Error("hard fail") });
      });
      mockRunAgent.mockImplementationOnce((params) =>
        runResult({ threadId: params.live.agentId, durationMs: 1, outcome: "completed", finalMessage: "restarted" }),
      );
      try {
        const outcome = await delegate({
          parent: harness.parent as never,
          parentPath: "/root",
          control: harness.control,
          registry: harness.registry,
          taskPrompt: "inspect",
          taskId: "delegate-restart",
          runInBackground: false,
          forceSynchronous: true,
          plan,
          resumeManager: resumeManager as never,
        });
        expect(outcome.kind).toBe("sync_completed");
        if (outcome.kind !== "sync_completed") throw new Error("expected sync_completed");
        if (state === "ready") {
          expect(outcome.result.outcome).toBe("completed");
          expect(spawnSpy).toHaveBeenCalledTimes(2);
          expect(spawnSpy.mock.calls[1]?.[0].providerSelection).toEqual(pair);
          expect(harness.rolloutStore.getThreadSpawnEdge(outcome.thread.threadId)?.metadata.crossProvider)
            .toMatchObject(pair);
          expect(readSavedApiKey).toHaveBeenCalledTimes(2); // local preview and live preparation select the same saved key
        } else {
          expect(outcome.result.outcome).toBe("errored");
          expect(spawnSpy).toHaveBeenCalledTimes(1);
        }
      } finally {
        mockRunAgent.mockReset();
        harness.cleanup();
      }
    },
  );

  it("spawns a nested slash-model child through the real delegate and records its parent edge", async () => {
    mockRunAgent.mockReset();
    const harness = makeRealDelegateHarness("nested-cross-provider");
    (harness.parent as { eventLog: unknown }).eventLog = new EventLog();
    const config = {
      ...defaultConfig(), model_provider: "grok", model: "grok-4.6",
      agents: { cross_provider_enabled: true, allowed_providers: ["openrouter"] },
    };
    const modelsManager = new StaticModelsManager({ config, fallbackProvider: "grok" });
    const providerService = new SessionProviderService({
      initialProvider: createProvider("grok", { model: "grok-4.6", apiKey: "parent-key" }),
      readSavedApiKey: async () => "openrouter-key",
      resolvePreparationRequest: ({ provider, model }) => ({
        requested: resolveProviderRuntimeRequest({
          provider: provider as "openrouter", model, config, environment: {},
        }).requested,
      }),
    });
    Object.assign(harness.parent, {
      providerService,
      modelInfo: await modelsManager.getModelInfo("grok-4.6"),
      sessionConfiguration: {
        ...harness.parent.sessionConfiguration,
        collaborationMode: { model: "grok-4.6" },
      },
      services: {
        ...harness.parent.services,
        configStore: { current: () => config },
        modelsManager,
      },
    });
    const control = new AgentControl({ session: harness.parent as never, registry: harness.registry, maxDepth: 2 });
    control.registerSessionRoot(harness.parent.conversationId);
    let nestedOutcome: Awaited<ReturnType<typeof delegate>> | undefined;
    let outerId = "";
    mockRunAgent.mockImplementationOnce((params) => (async function* () {
      outerId = params.live.agentId;
      const childParent = {
        ...harness.parent,
        conversationId: outerId,
        providerService: providerService.forkForChild(
          createProvider("grok", { model: "grok-4.6", apiKey: "parent-key" }),
          { provider: "grok", model: "grok-4.6" },
        ),
      };
      const nestedPair = { provider: "openrouter", model: "openai/gpt-4o-mini" };
      const nestedPlan = await grantedTestPlan(childParent as Session, nestedPair,
        { slug: nestedPair.model, provider: nestedPair.provider, supportsToolUse: true } as Session["modelInfo"],
        "nested inspect", "nested-task", params.live.agentPath);
      nestedOutcome = await delegate({
        parent: childParent as never,
        parentPath: params.live.agentPath,
        control,
        registry: harness.registry,
        taskPrompt: "nested inspect",
        taskId: "nested-task",
        agentName: "nested",
        runInBackground: false,
        forceSynchronous: true,
        plan: nestedPlan,
      });
      return { threadId: outerId, durationMs: 1, outcome: "completed" as const };
    })());
    mockRunAgent.mockImplementationOnce((params) =>
      runResult({ threadId: params.live.agentId, durationMs: 1, outcome: "completed" }),
    );
    try {
      const outer = await delegate({
        parent: harness.parent as never,
        parentPath: "/root",
        control,
        registry: harness.registry,
        taskPrompt: "first inspect",
        agentName: "first",
        runInBackground: false,
        forceSynchronous: true,
      });
      expect(outer.kind).toBe("sync_completed");
      expect(nestedOutcome?.kind, nestedOutcome?.kind === "rejected" ? nestedOutcome.reason : undefined).toBe("sync_completed");
      if (nestedOutcome?.kind !== "sync_completed") throw new Error("nested delegate failed");
      expect(harness.rolloutStore.getThreadSpawnEdge(nestedOutcome.thread.threadId))
        .toMatchObject({
          parentThreadId: outerId,
          metadata: { crossProvider: { provider: "openrouter", model: "openai/gpt-4o-mini" } },
        });
    } finally {
      mockRunAgent.mockReset();
      harness.cleanup();
    }
  });

  it("restarts from the immutable session catalog when an ambient role changes", async () => {
    const harness = makeRealDelegateHarness(
      "changed-role-restart",
      (workspace) => {
        registerAgentRole(workspace, {
          name: "scanner",
          config: { disallowlist: ["Edit", "Write"] },
        });
      },
    );
    try {
      const spawnSpy = vi.spyOn(harness.control, "spawn");
      const shutdownSpy = vi.spyOn(harness.control, "shutdown");
      const resumeFromRolloutSpy = vi.spyOn(
        harness.control,
        "resumeAgentFromRollout",
      );
      const resumeManager = {
        recordFailure: vi.fn(() => ({
          kind: "restart" as const,
          reason: "hard_error",
        })),
        recordSuccess: vi.fn(),
        transferFailureCount: vi.fn(),
      };
      mockRunAgent.mockImplementationOnce((params) => {
        registerAgentRole(harness.control.roleWorkspace, {
          name: "scanner",
          config: { disallowlist: [] },
        });
        return runResult({
          threadId: params.live.agentId,
          durationMs: 10,
          outcome: "errored",
          error: new Error("hard fail"),
        });
      });
      mockRunAgent.mockImplementationOnce((params) =>
        runResult({
          threadId: params.live.agentId,
          durationMs: 12,
          outcome: "completed",
          finalMessage: "done from the captured catalog",
        }),
      );

      const outcome = await delegate({
        parent: harness.parent as never,
        parentPath: "/root",
        control: harness.control,
        registry: harness.registry,
        taskPrompt: "inspect only",
        role: "scanner",
        runInBackground: false,
        forceSynchronous: true,
        resumeManager: resumeManager as never,
      });

      expect(outcome.kind).toBe("sync_completed");
      if (outcome.kind !== "sync_completed") {
        throw new Error("expected sync_completed");
      }
      expect(outcome.result.outcome).toBe("completed");
      expect(outcome.result.finalMessage).toBe(
        "done from the captured catalog",
      );
      expect(outcome.thread.live.role.config.disallowlist).toEqual([
        "Edit",
        "Write",
      ]);
      expect(spawnSpy).toHaveBeenCalledTimes(2);
      expect(shutdownSpy).toHaveBeenCalledWith(
        expect.any(String),
        "delegate_restart",
      );
      expect(resumeFromRolloutSpy).not.toHaveBeenCalled();
      expect(harness.registry.activeCount).toBe(0);
    } finally {
      harness.cleanup();
    }
  });

  it("resumes from the immutable session catalog when an ambient role is removed", async () => {
    const harness = makeRealDelegateHarness(
      "removed-role-resume",
      (workspace) => {
        registerAgentRole(workspace, {
          name: "scanner",
          config: { disallowlist: ["Edit", "Write"] },
        });
      },
    );
    try {
      const spawnSpy = vi.spyOn(harness.control, "spawn");
      const shutdownSpy = vi.spyOn(harness.control, "shutdown");
      const resumeFromRolloutSpy = vi.spyOn(
        harness.control,
        "resumeAgentFromRollout",
      );
      const resumeManager = {
        recordFailure: vi.fn(() => ({
          kind: "resume" as const,
          reason: "transient_provider_error",
        })),
        recordSuccess: vi.fn(),
      };
      mockRunAgent.mockImplementationOnce((params) => {
        // Removing the exact workspace role leaves the public `scanner`
        // built-in alias available. Provenance must not fall through to it.
        _resetAgentRolesForTesting();
        return runResult({
          threadId: params.live.agentId,
          durationMs: 10,
          outcome: "errored",
          error: new Error("transient"),
        });
      });
      mockRunAgent.mockImplementationOnce((params) =>
        runResult({
          threadId: params.live.agentId,
          durationMs: 12,
          outcome: "completed",
          finalMessage: "done from the captured catalog",
        }),
      );

      const outcome = await delegate({
        parent: harness.parent as never,
        parentPath: "/root",
        control: harness.control,
        registry: harness.registry,
        taskPrompt: "inspect only",
        role: "scanner",
        runInBackground: false,
        forceSynchronous: true,
        resumeManager: resumeManager as never,
      });

      expect(outcome.kind).toBe("sync_completed");
      if (outcome.kind !== "sync_completed") {
        throw new Error("expected sync_completed");
      }
      expect(outcome.result.outcome).toBe("completed");
      expect(outcome.result.finalMessage).toBe(
        "done from the captured catalog",
      );
      expect(outcome.thread.live.role.config.disallowlist).toEqual([
        "Edit",
        "Write",
      ]);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(shutdownSpy).toHaveBeenCalledWith(
        expect.any(String),
        "delegate_resume",
      );
      expect(resumeFromRolloutSpy).toHaveBeenCalledOnce();
      expect(harness.registry.activeCount).toBe(0);
    } finally {
      harness.cleanup();
    }
  });
});

// A spawn refused before any child exists changed nothing. Without evidence
// spawn_agent filed the refusal as an unknown outcome, which gates the whole
// session behind /resolve (luna-mac F1).
describe("spawns refused before any child exists", () => {
  it.each([
    ["the concurrency limit", () => new AgentConcurrencyLimitError(4, 4), "AGENT_CONCURRENCY_LIMIT"],
    ["a full capacity queue", () => new AgentCapacityQueueFullError("capacity queue is full"), "AGENT_CAPACITY_QUEUE_FULL"],
    ["a taken agent path", () => new AgentPathExistsError("/root/worker"), "AGENT_SPAWN_REJECTED"],
    ["the depth cap", () => new MaxDepthExceededError(3, 2), "AGENT_SPAWN_REJECTED"],
  ] as const)("settles %s as confirmed_no_effect", async (_label, failure, code) => {
    const control = {
      spawn: vi.fn(async () => { throw failure(); }),
      shutdown: vi.fn(),
      resumeAgentFromRollout: vi.fn(),
    };
    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "work",
      agentName: "worker",
    });
    expect(outcome).toMatchObject({
      kind: "rejected",
      code,
      effectDisposition: { disposition: "confirmed_no_effect", evidenceKind: "boundary_not_crossed" },
    });
    expect(control.shutdown).not.toHaveBeenCalled();
  });

  it("keeps a spawn failure it cannot place before the commit unknown", async () => {
    const control = {
      spawn: vi.fn(async () => { throw new Error("durable spawn edge could not be stored"); }),
      shutdown: vi.fn(),
      resumeAgentFromRollout: vi.fn(),
    };
    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "work",
    });
    expect(outcome).toMatchObject({ kind: "rejected", code: "AGENT_SPAWN_REJECTED" });
    expect((outcome as { effectDisposition?: unknown }).effectDisposition).toBeUndefined();
  });

  it("refuses a second live agent with the same name in one session with no effect", async () => {
    const harness = makeRealDelegateHarness("same-name-live");
    // The path collision is reported on the session's event log.
    (harness.parent as { eventLog: unknown }).eventLog = new EventLog();
    const running = Promise.withResolvers<void>();
    mockRunAgent.mockImplementationOnce((params) => (async function* () {
      await running.promise;
      return { threadId: params.live.agentId, durationMs: 1, outcome: "completed" as const };
    })());
    try {
      const first = await delegate({
        parent: harness.parent as never, parentPath: "/root", control: harness.control,
        registry: harness.registry, taskPrompt: "first worker", agentName: "worker",
      });
      expect(first.kind).toBe("async_launched");
      const second = await delegate({
        parent: harness.parent as never, parentPath: "/root", control: harness.control,
        registry: harness.registry, taskPrompt: "second worker", agentName: "worker",
      });
      expect(second).toMatchObject({
        kind: "rejected",
        reason: expect.stringContaining("agent path already exists: /root/worker"),
        effectDisposition: { disposition: "confirmed_no_effect" },
      });
      expect(harness.control.listLive()).toHaveLength(1);
      running.resolve();
      if (first.kind === "async_launched") await first.thread.join();
    } finally {
      running.resolve();
      harness.cleanup();
    }
  });
});
