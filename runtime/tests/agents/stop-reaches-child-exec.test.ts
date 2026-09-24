/**
 * A Stop on the parent reaches a sub-agent's running exec (lane report B3).
 *
 * The root turn delegates with spawn_agent and waits with wait_agent while
 * the sub-agent runs a shell command. The owner Stop is the daemon's
 * `interruptAgentTurnIfMatches`: abort the root turn, latch the user stop,
 * interrupt every open spawn child. It must end the child's command, settle
 * the child's call from what the process did, and leave the session taking
 * the next prompt with nothing for `/resolve`. A service the child started
 * with `detach: true` is kept, and its call settles the same way. A process
 * the child's call already returned with a session id is stopped by the
 * owner's Stop after that call has settled.
 *
 * The child's tool wrapper copies the call's arguments, and the copies used
 * to drop the executor's non-enumerable `__abortSignal`: the Stop ended the
 * child's turn but never reached its exec, whose settlement then outlived
 * the child session and stayed an unknown outcome.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentControl } from "../../src/agents/control.js";
import { observeChildApprovalSessions } from "../../src/agents/child-approval-context.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { createAgentRoleWorkspace } from "../../src/agents/role.js";
import { buildFilteredRegistry } from "../../src/agents/run-agent.js";
import { createMultiAgentV2Tools } from "../../src/agents/v2/index.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { ConfigStore } from "../../src/config/store.js";
import { SessionProviderService } from "../../src/session/provider-service.js";
import type { LLMMessage, LLMProvider, LLMResponse } from "../../src/llm/types.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { disposeSandboxExecutionBroker } from "../../src/sandbox/execution-lifecycle.js";
import { bindExecutionAdmissionJournal } from "../../src/session/execution-admission-journal.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import {
  Session,
  type Event,
  type SessionOpts,
  type SessionServices,
} from "../../src/session/session.js";
import type {
  Config,
  ModelInfo,
  SessionConfiguration,
} from "../../src/session/turn-context.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";
import { listUnresolvedUnknownOutcomeEffects } from "../../src/state/unknown-outcome-gate.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import type { Tool } from "../../src/tools/types.js";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import { AsyncQueue } from "../../src/utils/async-queue.js";
import { enterCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";

// These commands use exec, so each shell has no descendants. The test runner
// sandbox denies ps; use Node's exit observation for the manager's post-exit
// check while retaining real processes, signals, and manager status changes.
vi.mock("../../src/utils/supervisedProcess.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/utils/supervisedProcess.js")>();
  return {
    ...original,
    terminateProcessTreeAndReport: async (child: { exitCode: number | null; signalCode: string | null }) => {
      if (child.exitCode === null && child.signalCode === null) {
        throw new Error("the process has not exited");
      }
      return { residualProcessesTerminated: false };
    },
  };
});

const STOP_REASON = "cancelled from AgenC Desktop";
const ROOT_TASK = "root-task: delegate the long command";
const CHILD_TASK = "child-task: run the long command";
const FOLLOW_UP = "follow-up after the stop";
/** The lane's Stop landed in about half a second; this bound is generous. */
const PROCESS_GONE_BOUND_MS = 5_000;

const usage = {
  promptTokens: 8,
  completionTokens: 4,
  totalTokens: 12,
  availability: "reported" as const,
  provenance: "provider" as const,
};

// A duration no other process on the host is likely to use.
const CHILD_SLEEP_SECONDS = "299.731";

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

function readPid(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

function journalEvents(path: string): Event[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; payload: Event })
    .filter((item) => item.type === "event_msg")
    .map((item) => item.payload);
}

/** The index of the last user message containing `marker`, or -1. */
function lastUserIndexWith(messages: readonly LLMMessage[], marker: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    // Terminal receipts repeat the task under unfinishedWork. Treat only a
    // direct user request as a fixture command, not a quoted child receipt.
    const directText = JSON.stringify(message.content ?? "")
      .split("<subagent_notification>", 1)[0]!;
    if (message.role === "user" && directText.includes(marker)) {
      return index;
    }
  }
  return -1;
}

function toolResultsAfter(messages: readonly LLMMessage[], index: number): number {
  return messages.slice(index + 1).filter((message) => message.role === "tool")
    .length;
}

/** Settles only by rejecting when `signal` aborts, as a provider stream does. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal === undefined) {
      reject(new Error("the model call carries no abort signal"));
      return;
    }
    const abort = (): void => reject(new Error(`aborted: ${String(signal.reason)}`));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

interface ScenarioOptions {
  readonly crossProvider?: boolean;
  /** The sub-agent's exec_command arguments, given the pid file to write. */
  readonly childExec: (
    pidFile: string,
    detachedPidFile: string,
    callIndex: number,
  ) => Readonly<Record<string, unknown>>;
  readonly childExecCount?: number;
  /**
   * Hold the sub-agent's next model call open until its turn is aborted, so
   * the Stop lands after the command's call has returned.
   */
  readonly holdChildAfterExec?: boolean;
}

interface Scenario {
  readonly root: Session;
  readonly control: AgentControl;
  readonly manager: UnifiedExecProcessManager;
  readonly cwd: string;
  readonly pidFile: string;
  readonly detachedPidFile: string;
  readonly followUpMarker: string;
  /** Child sessions in spawn order. */
  readonly children: Session[];
  /** Resolves once the held sub-agent model call is waiting. */
  readonly childHeld: Promise<void>;
  readonly startRootTurn: () => void;
  readonly rootTurnDone: () => Promise<void>;
  readonly runFollowUp: () => Promise<Event[]>;
  readonly cleanup: () => Promise<void>;
}

/**
 * A root session wired like the daemon's: the admission kernel, a canonical
 * journal, the production tool catalog with one exec manager, and the
 * spawn_agent / wait_agent tools over one AgentControl. The fake model
 * delegates, then waits; the sub-agent runs `childExec`; the follow-up
 * prompt runs one side-effecting command of its own.
 */
function createScenario(options: ScenarioOptions): Scenario {
  const previousHome = process.env.AGENC_HOME;
  const home = mkdtempSync(join(tmpdir(), "agenc-stop-child-exec-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "agenc-stop-child-exec-"));
  const sessionTempRoot = mkdtempSync(join(tmpdir(), "agenc-stop-child-exec-tmp-"));
  mkdirSync(join(cwd, ".git"));
  // Shell commands may write workspace files only under tmp/ and a few
  // build directories.
  mkdirSync(join(cwd, "tmp"));
  process.env.AGENC_HOME = home;
  const pidFile = join(cwd, "tmp", "child.pid");
  const detachedPidFile = join(cwd, "tmp", "detached.pid");
  const followUpMarker = join(cwd, "tmp", "follow-up.txt");

  const kernel = new ExecutionAdmissionKernel({
    agencHome: home,
    ownerId: "stop-child-exec-test",
    ownerPid: process.pid,
  });
  const rootAdmission = kernel.bindClient({
    cwd,
    scope: { runId: "stop-root", sessionId: "stop-root", autonomous: false },
  });

  let callSeq = 0;
  let markChildHeld!: () => void;
  const childHeld = new Promise<void>((resolve) => {
    markChildHeld = resolve;
  });
  const response = (
    content: string,
    toolCall?: { readonly name: string; readonly args: Record<string, unknown> },
  ): LLMResponse => ({
    content,
    usage,
    model: "fake-model",
    finishReason: toolCall === undefined ? "stop" : "tool_calls",
    toolCalls:
      toolCall === undefined
        ? []
        : [
            {
              id: `${toolCall.name}-${++callSeq}`,
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.args),
            },
          ],
  });
  const provider = {
    name: "fake",
    chat: vi.fn(async () => response("")),
    chatStream: vi.fn(async (
      messages: LLMMessage[],
      _onChunk: unknown,
      callOptions?: { readonly signal?: AbortSignal },
    ): Promise<LLMResponse> => {
      const child = lastUserIndexWith(messages, CHILD_TASK);
      if (child !== -1) {
        const callIndex = toolResultsAfter(messages, child);
        if (callIndex < (options.childExecCount ?? 1)) {
          return response("", {
            name: "exec_command",
            args: { ...options.childExec(pidFile, detachedPidFile, callIndex) },
          });
        }
        if (options.holdChildAfterExec === true) {
          markChildHeld();
          await untilAborted(callOptions?.signal);
        }
        return response("child done");
      }
      const followUp = lastUserIndexWith(messages, FOLLOW_UP);
      if (followUp !== -1) {
        return toolResultsAfter(messages, followUp) === 0
          ? response("", {
              name: "exec_command",
              args: { cmd: `echo follow-up-ran > ${JSON.stringify(followUpMarker)}` },
            })
          : response("follow-up done");
      }
      const root = lastUserIndexWith(messages, ROOT_TASK);
      return toolResultsAfter(messages, root) === 0
        ? response("", {
            name: "spawn_agent",
            args: {
              message: CHILD_TASK,
              task_name: "runner",
              fork_turns: "none",
              isolation: "none",
              ...(options.crossProvider ? { provider: "openrouter", model: "openai/gpt-4o-mini" } : {}),
            },
          })
        : response("", { name: "wait_agent", args: { timeout_ms: 300_000 } });
    }),
    healthCheck: vi.fn(async () => true),
    getExecutionProfile: async () => ({
      provider: "fake",
      model: "fake-model",
      usageReporting: "authoritative",
      supportsMaxOutputTokens: true,
    }),
  } as unknown as LLMProvider;

  const manager = new UnifiedExecProcessManager({
    cwd,
    sessionTempRoot,
    shellPath: "/bin/sh",
  });
  // No platform sandbox: `detach: true` requires full access.
  const broker = new SandboxExecutionBroker({
    mode: "danger_full_access",
    cwd,
    probe: (probe) => ({ kind: "ready", mode: probe.mode, platform: process.platform }),
  });
  const roleWorkspace = createAgentRoleWorkspace(cwd);
  const agentRegistry = new AgentRegistry();
  // The catalog is built before the session exists.
  let bound: Session | null = null;
  let control!: AgentControl;
  const registry = buildToolRegistry({
    workspaceRoot: cwd,
    unifiedExecManager: manager,
    requireAdmission: false,
    modelFacingTools: createMultiAgentV2Tools({
      getSession: () => bound,
      workspace: roleWorkspace,
      ensureAgentControl: () => ({ control, registry: agentRegistry }),
    }),
  });
  const sessionConfiguration: SessionConfiguration = {
    cwd,
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "danger_full_access" },
    fileSystemSandboxPolicy: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] },
    networkSandboxPolicy: { allowlist: [], denylist: [], allowManagedDomainsOnly: false },
    windowsSandboxLevel: "none",
    collaborationMode: { model: options.crossProvider ? "grok-4.6" : "fake-model" },
    dynamicTools: [],
    sessionSource: "cli_main",
    provider: { slug: options.crossProvider ? "grok" : "fake" } as unknown as SessionConfiguration["provider"],
  };
  const config = {
    model: options.crossProvider ? "grok-4.6" : "fake-model",
    ...(options.crossProvider ? { model_provider: "grok" } : {}),
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
    slug: options.crossProvider ? "grok-4.6" : "fake-model",
    effectiveContextWindowPercent: 100,
    contextWindow: 131_072,
    maxOutputTokens: 32,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  } as unknown as ModelInfo;
  const configStore = new ConfigStore({
    home, cwd,
    ...(options.crossProvider ? {
      base: { agents: { cross_provider_enabled: true, allowed_providers: ["openrouter"] } },
    } : {}),
  });
  const targetProvider = options.crossProvider
    ? { ...provider, name: "openrouter", getExecutionProfile: async () => ({
        provider: "openrouter", model: "openai/gpt-4o-mini",
        usageReporting: "authoritative" as const, supportsMaxOutputTokens: true,
      }) } as LLMProvider
    : undefined;
  const providerService = options.crossProvider
    ? new SessionProviderService({
        initialProvider: provider,
        initialProviderName: "grok",
        initialModel: "grok-4.6",
      })
    : undefined;
  if (providerService !== undefined && targetProvider !== undefined) {
    vi.spyOn(providerService, "previewChildDestination").mockResolvedValue({
      endpoint: "https://openrouter.ai/api/v1", authProfile: "api_key", billingSource: "byok",
    });
    vi.spyOn(providerService, "prepareChild").mockImplementation(async (selection) => ({
      expectedRevision: 0,
      managedDefaultOutputCap: false,
      binding: {
        provider: selection.provider,
        model: selection.model,
        instance: targetProvider,
        factoryOptions: { model: selection.model },
        revision: 1,
      },
    }));
  }
  enterCanonicalSettingsAuthority(configStore);
  const root = new Session({
    conversationId: "stop-root",
    roleWorkspace,
    initialState: { sessionConfiguration, history: [] } as unknown as SessionOpts["initialState"],
    features: {},
    services: {
      permissionModeRegistry: new PermissionModeRegistry(
        createEmptyToolPermissionContext({
          mode: "bypassPermissions",
          isBypassPermissionsModeAvailable: true,
          bypassPermissionsAcceptedIn: [cwd],
        }),
      ),
      mcpConnectionManager: {
        setApprovalPolicy: () => {},
        setSandboxPolicy: () => {},
        requiredStartupFailures: async () => [],
      },
      mcpStartupCancellationToken: { cancel: () => {}, isCancelled: () => false },
      provider,
      ...(providerService !== undefined ? { providerService } : {}),
      ...(options.crossProvider ? { crossProviderConsent: {
        ownerSessionId: "stop-root", sessionEpoch: "stop-test-human",
        request: async (_session: Session, disclosure: { taskId: string; scopeKey: string; payloadKey: string }) => ({
          kind: "granted" as const,
          grant: { kind: "once" as const, ownerSessionId: "stop-root", sessionEpoch: "stop-test-human",
            taskId: disclosure.taskId, scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey },
        }),
      } } : {}),
      registry,
      hooks: { executeStop: async () => ({}) },
      admissionRequired: true,
      executionAdmission: rootAdmission,
      sandboxExecutionBroker: broker,
      unifiedExecManager: manager,
      configStore,
      runtimeOptions: resolveAgentRuntimeOptions({ sessionTempRoot }),
    } as unknown as SessionServices,
    jsRepl: { id: "repl-test" },
    config,
    modelInfo,
    eventQueue: new AsyncQueue<Event>(),
  });
  bound = root;
  const store = new RolloutStore({
    cwd,
    sessionId: root.conversationId,
    agencVersion: "0.2.0",
    sessionTempRoot,
  });
  store.open({
    sessionId: root.conversationId,
    timestamp: new Date().toISOString(),
    cwd,
    originator: "stop-child-exec-test",
    agencVersion: "0.2.0",
    model: "fake-model",
    modelProvider: "fake",
  });
  root.mountRolloutStore(store);
  root.onBeforeDurableClose(bindExecutionAdmissionJournal(root, rootAdmission));
  control = new AgentControl({ session: root, registry: agentRegistry });
  // As bootstrap does: the root claims its thread before anything spawns,
  // so its children are the root's open spawn children.
  control.registerSessionRoot(root.conversationId);

  const children: Session[] = [];
  const unobserve = observeChildApprovalSessions(root, (child) => {
    children.push(child);
    return () => {};
  });

  const drainTurn = async (message: string, sink?: Event[]): Promise<void> => {
    const unsubscribe =
      sink === undefined ? () => {} : root.eventLog.subscribe((event) => sink.push(event));
    try {
      for await (const _event of root.runTurn(message)) {
        // drain
      }
    } finally {
      unsubscribe();
    }
  };
  let rootTurn: Promise<void> | undefined;

  return {
    root,
    control,
    manager,
    cwd,
    pidFile,
    detachedPidFile,
    followUpMarker,
    children,
    childHeld,
    startRootTurn: () => {
      rootTurn = drainTurn(ROOT_TASK);
      void rootTurn.catch(() => {});
    },
    rootTurnDone: async () => {
      await rootTurn;
    },
    runFollowUp: async () => {
      // The daemon clears the stop latch when the user's next message arrives.
      root.clearUserStop();
      const events: Event[] = [];
      await drainTurn(FOLLOW_UP, events);
      return events;
    },
    cleanup: async () => {
      unobserve();
      for (const path of [pidFile, detachedPidFile]) {
        const leftover = readPid(path);
        // The fixture just wrote this PID and each test completes well before
        // its sleep duration. Kill detached fixtures after the assertions.
        if (leftover !== undefined) {
          try {
            process.kill(leftover, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      await control.shutdownAll("test cleanup").catch(() => {});
      await root.shutdown().catch(() => {});
      await manager.closeAll().catch(() => {});
      await disposeSandboxExecutionBroker(broker).catch(() => {});
      kernel.close();
      if (previousHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
      rmSync(sessionTempRoot, { recursive: true, force: true });
    },
  };
}

/**
 * The daemon's owner Stop, step for step as `interruptAgentTurnIfMatches`
 * performs it: abort the active root turn, latch the user stop, then
 * interrupt each open spawn child (which cascades to its descendants).
 */
async function ownerStop(scenario: Scenario): Promise<void> {
  const turnId = scenario.root.activeTurn.unsafePeek()?.turnId;
  expect(turnId).toBeDefined();
  const earlyDescendants = new Set(
    scenario.control.liveThreadSpawnDescendants(scenario.root.conversationId),
  );
  expect(await scenario.root.abortTurnIfActive(turnId!, "interrupted")).toBe(true);
  scenario.root.markStoppedByUser();
  const children = scenario.control.openThreadSpawnChildren(
    scenario.root.conversationId,
  );
  expect(children).toHaveLength(1);
  scenario.control.stopOpenSpawnChildren(scenario.root.conversationId, STOP_REASON, earlyDescendants);
}

/** Wait until the child's run has closed its canonical journal. */
async function childRunClosed(child: Session): Promise<Event[]> {
  const path = child.rolloutStore!.rolloutPath;
  return waitFor(
    () => {
      const events = journalEvents(path);
      return events.some((event) => event.msg.type === "run_terminal")
        ? events
        : undefined;
    },
    15_000,
    "the sub-agent's run terminal",
  );
}

/** The journal events of the sub-agent's one exec_command call, by type. */
function execCallEvents(
  events: readonly Event[],
  index = 0,
): (type: string) => Event[] {
  const execCall = events.filter(
    (event) =>
      event.msg.type === "tool_call_started" &&
      event.msg.payload.toolName === "exec_command",
  )[index];
  expect(execCall).toBeDefined();
  const callId = (execCall!.msg.payload as { readonly callId: string }).callId;
  return (type) =>
    events.filter(
      (event) =>
        event.msg.type === type &&
        (event.msg.payload as { readonly callId?: string }).callId === callId,
    );
}

function expectSettledFromProcessEvidence(
  events: readonly Event[],
  evidenceRef: string,
): void {
  const forCall = execCallEvents(events);
  // The Stop reached the call after it started the command.
  expect(forCall("effect_unknown_outcome")).toEqual([
    expect.objectContaining({
      msg: expect.objectContaining({
        payload: expect.objectContaining({
          reason: "caller_abort_after_effect_boundary",
          callerStop: "abort",
        }),
      }),
    }),
  ]);
  // It never claims no effect for a command that ran.
  expect(forCall("effect_result")).toEqual([]);
  // The command's own evidence settles it: nothing is left for /resolve.
  expect(forCall("effect_review_resolved")).toEqual([
    expect.objectContaining({
      msg: expect.objectContaining({
        payload: expect.objectContaining({
          resolution: expect.objectContaining({
            disposition: "confirmed_committed",
            actorKind: "system_settlement",
            evidenceRef,
            workflowStatus: "resolved",
          }),
        }),
      }),
    }),
  ]);
}

function expectNothingToResolve(scenario: Scenario, child: Session): void {
  const driver = openStateDatabases({ cwd: scenario.cwd });
  try {
    expect(listUnresolvedUnknownOutcomeEffects(driver, child.conversationId)).toEqual([]);
    expect(listUnresolvedUnknownOutcomeEffects(driver, scenario.root.conversationId)).toEqual([]);
  } finally {
    driver.close();
  }
}

async function expectFollowUpRuns(scenario: Scenario): Promise<void> {
  const events = await scenario.runFollowUp();
  const completed = events.filter((event) => event.msg.type === "tool_call_completed");
  expect(completed).toEqual([
    expect.objectContaining({
      msg: expect.objectContaining({
        payload: expect.objectContaining({ toolName: "exec_command", isError: false }),
      }),
    }),
  ]);
  expect(events.some((event) => event.msg.type === "turn_failed")).toBe(false);
  expect(readFileSync(scenario.followUpMarker, "utf8").trim()).toBe("follow-up-ran");
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("a child tool call keeps the executor's abort signal", () => {
  it("hands the wrapped tool the same non-enumerable signal", async () => {
    const execute = vi.fn(async (_args: Record<string, unknown>) => ({ content: "{}" }));
    const tool = {
      name: "system.echo",
      description: "echo",
      inputSchema: { type: "object" },
      execute,
    } as unknown as Tool;
    const child = buildFilteredRegistry(
      { tools: [tool], toLLMTools: () => [], dispatch: async () => ({ content: "unused" }) },
      { childConversationId: "child-abort-signal" },
    );
    const controller = new AbortController();
    const args: Record<string, unknown> = { value: "hello" };
    Object.defineProperty(args, "__abortSignal", {
      value: controller.signal,
      enumerable: false,
      configurable: true,
    });

    await child.tools[0]!.execute(args);

    const received = execute.mock.calls[0]![0];
    expect(received.__abortSignal).toBe(controller.signal);
    expect(Object.keys(received)).not.toContain("__abortSignal");
  });
});

describe.skipIf(process.platform === "win32")(
  "an owner Stop reaches a sub-agent's exec",
  () => {
  it("ends the sub-agent's command, settles its call, and takes the next prompt", async () => {
      const scenario = createScenario({
        childExec: (pidFile) => ({
          cmd: `echo $$ > ${JSON.stringify(pidFile)}; exec sleep ${CHILD_SLEEP_SECONDS}`,
          // The command is still in its yield window when the Stop lands.
          yield_time_ms: 30_000,
        }),
      });
      cleanups.push(scenario.cleanup);

      scenario.startRootTurn();
      const pid = await waitFor(
        () => readPid(scenario.pidFile),
        20_000,
        "the sub-agent's command to start",
      );
      expect(processIsRunning(pid)).toBe(true);

      await ownerStop(scenario);

      await waitFor(
        () => (processIsRunning(pid) ? undefined : true),
        PROCESS_GONE_BOUND_MS,
        "the sub-agent's command to end after the Stop",
      );
      await scenario.rootTurnDone();
      const child = scenario.children[0]!;
      const events = await childRunClosed(child);
      expectSettledFromProcessEvidence(
        events,
        "tool:system.exec-command:process-exit",
      );
      expectNothingToResolve(scenario, child);
      await expectFollowUpRuns(scenario);
    });

    it("ends a cross-provider child's shell through the owner Stop path", async () => {
      const scenario = createScenario({
        crossProvider: true,
        childExec: (pidFile) => ({
          cmd: `echo $$ > ${JSON.stringify(pidFile)}; exec sleep ${CHILD_SLEEP_SECONDS}`,
          yield_time_ms: 30_000,
        }),
      });
      cleanups.push(scenario.cleanup);

      scenario.startRootTurn();
      const pid = await waitFor(() => readPid(scenario.pidFile), 20_000, "the cross-provider child's shell");
      expect(processIsRunning(pid)).toBe(true);
      const children = scenario.control.openThreadSpawnChildren(scenario.root.conversationId);
      expect(children).toHaveLength(1);
      expect(children[0]?.[1].crossProvider).toMatchObject({
        provider: "openrouter", model: "openai/gpt-4o-mini",
      });

      await ownerStop(scenario);
      await waitFor(() => processIsRunning(pid) ? undefined : true, PROCESS_GONE_BOUND_MS, "the cross-provider shell to end");
      await scenario.rootTurnDone();
      const child = scenario.children[0]!;
      expectSettledFromProcessEvidence(await childRunClosed(child), "tool:system.exec-command:process-exit");
      expectNothingToResolve(scenario, child);
    });

    it("keeps a service the sub-agent detached, settles its call, and takes the next prompt", async () => {
      const scenario = createScenario({
        childExec: (pidFile) => ({
          cmd: `echo $$ > ${JSON.stringify(pidFile)}; exec sleep ${CHILD_SLEEP_SECONDS}`,
          detach: true,
          // The Stop lands while the call still watches the service start.
          yield_time_ms: 10_000,
        }),
      });
      cleanups.push(scenario.cleanup);

      scenario.startRootTurn();
      const pid = await waitFor(
        () => readPid(scenario.pidFile),
        20_000,
        "the sub-agent's service to start",
      );

      await ownerStop(scenario);

      await scenario.rootTurnDone();
      const child = scenario.children[0]!;
      const events = await childRunClosed(child);
      expectSettledFromProcessEvidence(
        events,
        "tool:system.exec-command:process-detached",
      );
      expect(processIsRunning(pid)).toBe(true);
      expectNothingToResolve(scenario, child);
      await expectFollowUpRuns(scenario);
      // Neither the child's end nor the next turn stopped the service.
      expect(processIsRunning(pid)).toBe(true);
    });

    it("ends the child's yielded shell but keeps its detached service, the root shell, and a foreign shell", async () => {
      const scenario = createScenario({
        childExec: (pidFile, detachedPidFile, callIndex) =>
          callIndex === 0
            ? {
                cmd: `echo $$ > ${JSON.stringify(detachedPidFile)}; exec sleep ${CHILD_SLEEP_SECONDS}`,
                detach: true,
                yield_time_ms: 250,
              }
            : {
                cmd: `echo $$ > ${JSON.stringify(pidFile)}; exec sleep ${CHILD_SLEEP_SECONDS}`,
                // The call returns the running process with a session id.
                yield_time_ms: 250,
              },
        childExecCount: 2,
        holdChildAfterExec: true,
      });
      cleanups.push(scenario.cleanup);

      scenario.startRootTurn();
      const pid = await waitFor(
        () => readPid(scenario.pidFile),
        20_000,
        "the sub-agent's command to start",
      );
      // The command's call is over; the sub-agent is waiting on its model.
      await scenario.childHeld;
      const detachedPid = readPid(scenario.detachedPidFile);
      expect(detachedPid).toBeDefined();
      expect(processIsRunning(detachedPid!)).toBe(true);
      const child = scenario.children[0]!;
      const yielded = scenario.manager.listOwnedProcesses({ ownerId: child.conversationId });
      expect(yielded).toHaveLength(1);
      expect(yielded[0]?.status).toBe("running");

      const rootProcess = await scenario.manager.execCommand({
        cmd: `exec sleep ${CHILD_SLEEP_SECONDS}`,
        yield_time_ms: 250,
        ownerId: scenario.root.conversationId,
      });
      const foreignProcess = await scenario.manager.execCommand({
        cmd: `exec sleep ${CHILD_SLEEP_SECONDS}`,
        yield_time_ms: 250,
        ownerId: "another-conversation",
      });
      expect(rootProcess.session_id).toBeDefined();
      expect(foreignProcess.session_id).toBeDefined();

      await ownerStop(scenario);
      expect(scenario.manager.listOwnedProcesses({ ownerId: child.conversationId })[0]?.status).toBe("stopping");

      await scenario.rootTurnDone();
      const events = await childRunClosed(child);
      const forCall = execCallEvents(events, 1);
      // That call settled when it returned; nothing of it was in flight.
      expect(forCall("effect_unknown_outcome")).toEqual([]);
      expect(forCall("effect_result")).toEqual([
        expect.objectContaining({
          msg: expect.objectContaining({
            payload: expect.objectContaining({
              outcome: "committed",
              effectBoundary: "crossed",
            }),
          }),
        }),
      ]);
      await waitFor(
        () => (processIsRunning(pid) ? undefined : true),
        PROCESS_GONE_BOUND_MS,
        "the yielded sub-agent command to end after the Stop",
      );
      await waitFor(
        () => scenario.manager.listOwnedProcesses({ ownerId: child.conversationId })[0]?.status === "killed" ? true : undefined,
        PROCESS_GONE_BOUND_MS,
        "the yielded sub-agent command to be observed exited",
      );
      expect(scenario.manager.listOwnedProcesses({ ownerId: scenario.root.conversationId })[0]?.status).toBe("running");
      expect(scenario.manager.listOwnedProcesses({ ownerId: "another-conversation" })[0]?.status).toBe("running");
      expect(processIsRunning(detachedPid!)).toBe(true);
      expectNothingToResolve(scenario, child);
      await expectFollowUpRuns(scenario);
      expect(scenario.manager.listOwnedProcesses({ ownerId: scenario.root.conversationId })[0]?.status).toBe("running");
      expect(scenario.manager.listOwnedProcesses({ ownerId: "another-conversation" })[0]?.status).toBe("running");
      expect(processIsRunning(detachedPid!)).toBe(true);
    });
  },
);
