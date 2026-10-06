/**
 * Every sub-agent runs at its provider's effort and speed limits, whatever
 * path creates it, not only spawn_agent: a spawn_agents_on_csv worker and a
 * workflow agent go through the real delegate and runAgent here. The parent
 * runs at xhigh on the priority tier and the user set no limits, so each
 * child must run at its model's lowest effort with no tier. A fork of the
 * full conversation still keeps its parent's effort and tier.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentControl } from "../../src/agents/control.js";
import { delegate } from "../../src/agents/delegate.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { createAgentRoleWorkspace } from "../../src/agents/role.js";
import { CsvAgentJobsRepositoryAuthority } from "../../src/app-server/csv-agent-jobs-authority.js";
import { createWorkflowSessionSeams } from "../../src/app-server/workflow/session-adapters.js";
import type { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { _clearAgentControlCacheForTesting, _setAgentControlForTesting } from "../../src/bin/delegate-tool.js";
import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import { ConfigStore } from "../../src/config/store.js";
import type { LLMChatOptions, LLMMessage, LLMProvider, LLMResponse, StreamProgressCallback } from "../../src/llm/types.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { Session, type Event, type SessionOpts, type SessionServices } from "../../src/session/session.js";
import type { Config, ModelInfo, SessionConfiguration } from "../../src/session/turn-context.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";
import { AsyncQueue } from "../../src/utils/async-queue.js";
import { enterCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A workspace in a git repository with one commit, removed after the test. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "agenc-subagent-limits-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "tests@example.com");
  git(root, "config", "user.name", "Tests");
  writeFileSync(join(root, "README.md"), "base\n", "utf8");
  git(root, "add", "README.md");
  git(root, "commit", "-q", "-m", "base");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** The options of every model call whose messages hold `marker`. */
function recordingProvider(marker: string): { provider: LLMProvider; calls: LLMChatOptions[] } {
  const calls: LLMChatOptions[] = [];
  const response = (): LLMResponse => ({ content: "done", toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, model: "gpt-5.4", finishReason: "stop" });
  const provider = {
    name: "fake",
    chat: vi.fn(async () => response()),
    chatStream: vi.fn(async (messages: LLMMessage[], _onChunk: StreamProgressCallback, options?: LLMChatOptions) => {
      if (options !== undefined && JSON.stringify(messages).includes(marker)) calls.push(options);
      return response();
    }),
    healthCheck: vi.fn(async () => true),
  } satisfies LLMProvider;
  return { provider, calls };
}

/** A root session on openai/gpt-5.4 at xhigh effort on the priority tier, with no sub-agent limits. */
function parentSession(cwd: string, provider: LLMProvider): Session {
  const sessionConfiguration: SessionConfiguration = {
    cwd,
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "danger_full_access" },
    fileSystemSandboxPolicy: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] },
    networkSandboxPolicy: { allowlist: [], denylist: [], allowManagedDomainsOnly: false },
    windowsSandboxLevel: "none",
    collaborationMode: { model: "gpt-5.4", reasoningEffort: "xhigh" },
    serviceTier: "priority",
    dynamicTools: [],
    sessionSource: "cli_main",
    provider: { slug: "openai" } as unknown as SessionConfiguration["provider"],
  };
  const config = {
    model: "gpt-5.4",
    cwd,
    features: {},
    multiAgentV2: { usageHintEnabled: false, usageHintText: "", hideSpawnAgentMetadata: false },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: { allowedEnvVars: [], blockedEnvVars: [] },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  } as unknown as Config;
  const modelInfo = {
    slug: "gpt-5.4",
    effectiveContextWindowPercent: 100,
    contextWindow: 131_072,
    supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
    serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  } as unknown as ModelInfo;
  const configStore = new ConfigStore({ cwd, home: join(cwd, ".agenc-home"), base: { agents: {} } });
  enterCanonicalSettingsAuthority(configStore);
  const session = new Session({
    conversationId: `limits-parent-${Math.random().toString(16).slice(2)}`,
    roleWorkspace: createAgentRoleWorkspace(cwd),
    initialState: { sessionConfiguration, history: [] } as unknown as SessionOpts["initialState"],
    features: {},
    services: {
      permissionModeRegistry: new PermissionModeRegistry(createEmptyToolPermissionContext({
        mode: "bypassPermissions", isBypassPermissionsModeAvailable: true, bypassPermissionsAcceptedIn: [cwd],
      })),
      mcpConnectionManager: { setApprovalPolicy: () => {}, setSandboxPolicy: () => {}, requiredStartupFailures: async () => [] },
      mcpStartupCancellationToken: { cancel: () => {}, isCancelled: () => false },
      provider,
      registry: { tools: [], toLLMTools: () => [], dispatch: async () => ({ content: "", isError: false }) },
      hooks: { executeStop: async () => ({}) },
      admissionRequired: false,
      configStore,
      runtimeOptions: resolveAgentRuntimeOptions({}),
      sandboxExecutionBroker: explicitDangerBroker.forkForCwd(cwd),
    } as unknown as SessionServices,
    jsRepl: { id: "repl-test" },
    config,
    modelInfo,
    eventQueue: new AsyncQueue<Event>(),
  });
  cleanups.push(() => session.shutdown().catch(() => {}));
  // A durable journal, as a real root session has: a child seeded with an
  // invocation envelope (a CSV worker) needs one.
  const store = new RolloutStore({ cwd, sessionId: session.conversationId, agencVersion: "0.2.0", sessionTempRoot: tmpdir() });
  store.open({ sessionId: session.conversationId, timestamp: new Date().toISOString(), cwd,
    originator: "subagent-limits-test", agencVersion: "0.2.0", model: "gpt-5.4", modelProvider: "openai" });
  session.mountRolloutStore(store);
  return session;
}

describe("sub-agent limits on every path that creates a child", () => {
  it("runs a spawn_agents_on_csv worker at its provider's limits, not its parent's effort and tier", async () => {
    const cwd = workspace();
    const { provider, calls } = recordingProvider("process the value field");
    const session = parentSession(cwd, provider);
    const registry = new AgentRegistry();
    const control = new AgentControl({ session: session as never, registry });
    control.registerSessionRoot(session.conversationId);
    _setAgentControlForTesting(session, { control, registry });
    cleanups.push(() => _clearAgentControlCacheForTesting(session));
    cleanups.push(() => control.shutdownAll("test cleanup").then(() => {}));
    const csvAgentJobsRepositories = new CsvAgentJobsRepositoryAuthority({ agencHome: join(cwd, ".agenc-home") });
    cleanups.push(() => csvAgentJobsRepositories.close?.());
    writeFileSync(join(cwd, "input.csv"), "id,value\nrow1,a\n", "utf8");
    const csv = createModelFacingTools({ workspaceRoot: cwd, csvAgentJobsRepositories, getSession: () => session })
      .find((tool) => tool.name === "spawn_agents_on_csv")!;

    await csv.execute({ csv_path: join(cwd, "input.csv"), instruction: "process the value field", id_column: "id" });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.reasoningEffort).toBe("low");
    expect(calls[0]?.serviceTier).toBeUndefined();
  });

  it("runs a workflow agent at its provider's limits, not its parent's effort and tier", async () => {
    const cwd = workspace();
    const { provider, calls } = recordingProvider("workflow plan task");
    const session = parentSession(cwd, provider);
    const agencHome = join(cwd, ".agenc-home");
    const driver = openStateDatabases({ cwd, agencHome });
    cleanups.push(() => driver.close());
    const repo = new StateRunDurabilityRepository(driver);
    const seams = createWorkflowSessionSeams({
      agencHome, env: {}, argv: ["node", "agenc"], kernel: {} as ExecutionAdmissionKernel,
      durability: () => repo, resolveRunRepoPath: () => cwd, resolveRunPolicy: () => undefined,
      fallbackCwd: cwd, warn: () => {},
      bootstrap: async () => ({ session, rolloutStore: { runEpoch: 1 }, shutdown: async () => {} }) as never,
    });
    cleanups.push(() => seams.close());
    await seams.journal.open("wf-limits", { repoPath: cwd });

    const outcome = await seams.spawner.spawn({
      kind: "plan", childRunId: "wf-limits:plan#1", spec: { runId: "wf-limits", repoPath: cwd } as never,
      worktreePath: cwd, prompt: "workflow plan task", signal: new AbortController().signal,
    });

    expect(outcome.status, outcome.finalMessage ?? "").toBe("completed");
    expect(calls[0]?.reasoningEffort).toBe("low");
    expect(calls[0]?.serviceTier).toBeUndefined();
  });

  it("keeps a full-history fork on its parent's effort and tier", async () => {
    const cwd = workspace();
    const { provider, calls } = recordingProvider("continue with everything");
    const session = parentSession(cwd, provider);
    const registry = new AgentRegistry();
    const control = new AgentControl({ session: session as never, registry });
    control.registerSessionRoot(session.conversationId);
    const outcome = await delegate({
      parent: session, parentPath: "/root" as never, control, registry,
      taskPrompt: "continue with everything", agentName: "fork",
      forkMode: { kind: "full_history" }, runInBackground: false, forceSynchronous: true,
    });

    expect(outcome.kind).toBe("sync_completed");
    expect(calls[0]?.reasoningEffort).toBe("xhigh");
    expect(calls[0]?.serviceTier).toBe("priority");
  });
});
