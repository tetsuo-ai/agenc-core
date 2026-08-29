import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const policyLimitsMocks = vi.hoisted(() => ({
  configurePolicyLimitsService: vi.fn(),
}));

vi.mock("../services/policyLimits/index.js", () => ({
  configurePolicyLimitsService: policyLimitsMocks.configurePolicyLimitsService,
}));

import {
  ConfiguredHooksRuntime,
  type HookInstallTarget,
} from "../hooks/configured-hooks.js";
import { createHookExecutionAuthority } from "../hooks/execution-authority.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";
import { defaultConfig } from "../config/schema.js";
import {
  COORDINATED_CONFIG_STORE_PUBLICATION,
  ConfigStore,
  type PreparedConfigStoreReload,
} from "../config/store.js";
import { trustProjectSync } from "../permissions/trust/project-trust.js";
import {
  PermissionAuthorityUnavailableError,
  PermissionModeRegistry,
} from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import {
  applyPermissionRulesSnapshot,
  readPermissionRulesSnapshot,
} from "../permissions/settings.js";
import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import type { PostToolUseHook } from "../tools/hooks.js";
import {
  bindExecutionAdmissionJournal,
  buildBootstrapSessionServices,
  createHooksService,
  loadBootstrapHooks,
  loadBootstrapLspServersInBackground,
  loadBootstrapLspServers,
  shutdownBootstrapLspServers,
} from "./bootstrap-services.js";
import type { ExecutionAdmissionClient } from "../budget/admission-client.js";
import type { AdmissionJournalEvent } from "../budget/admission-types.js";
import type { Event } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import { createProvider } from "../llm/provider.js";
import { normalizeLspServerConfig } from "../services/lsp/config.js";
import {
  _resetLspManagerForTesting,
  getInitializationStatus,
  getLspServerManager,
  initializeLspServerManager,
  shutdownLspServerManager,
  waitForInitialization,
} from "../services/lsp/manager.js";
import type { LSPServerInstance } from "../services/lsp/LSPServerInstance.js";
import { bootstrapSession } from "../session/bootstrap.js";

const TEST_RUNTIME_OPTIONS = Object.freeze({
  simpleMode: false,
  allowUntrustedHooks: false,
});
const TEST_COMMAND_EXECUTION_AUTHORITY = Object.freeze({
  path: "/bin/sh",
  commandWrapperArgv: Object.freeze([]),
  childEnvironment: Object.freeze({
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  }),
});
const TRUSTED_HOOK_EXECUTION_AUTHORITY = createHookExecutionAuthority({
  runtimeOptions: TEST_RUNTIME_OPTIONS,
  isWorkspaceTrusted: () => true,
});

afterEach(() => {
  policyLimitsMocks.configurePolicyLimitsService.mockReset();
});

function mockPolicyLimits(): void {
  policyLimitsMocks.configurePolicyLimitsService.mockReturnValue({
    initializePolicyLimitsLoadingPromise: vi.fn(),
    loadPolicyLimits: vi.fn(async () => {}),
    stopBackgroundPolling: vi.fn(),
  } as never);
}

function sessionStartEchoCommand(): string {
  return [
    "node -e \"let s='';",
    "process.stdin.on('data', c => s += c);",
    "process.stdin.on('end', () => {",
    "const x = JSON.parse(s);",
    "process.stdout.write('source=' + x.source + ';model=' + x.model + ';mode=' + x.permission_mode);",
    '});"',
  ].join(" ");
}

function sessionStartStopCommand(): string {
  return [
    'node -e "process.stdout.write(JSON.stringify({',
    "continue: false,",
    "stopReason: 'pause startup',",
    "hookSpecificOutput: {",
    "hookEventName: 'SessionStart',",
    "additionalContext: 'startup context'",
    "}",
    '}));"',
  ].join(" ");
}

function drainSessionEvents(session: {
  readonly txEvent: { tryRecv(): unknown };
}): unknown[] {
  const events: unknown[] = [];
  while (true) {
    const next = session.txEvent.tryRecv();
    if (next === null || next === undefined) return events;
    events.push(next);
  }
}

describe("loadBootstrapHooks", () => {
  test("installs the built-in auto-fix post hook once across reloads", () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: process.cwd(),
      env: process.env,
      agencHome: "/tmp/agenc-bootstrap-hooks-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
      sandboxExecutionBroker: explicitDangerBroker,
      executionAuthority: TRUSTED_HOOK_EXECUTION_AUTHORITY,
    });
    const target: HookInstallTarget = {
      preToolUseHooks: [],
      postToolUseHooks: [],
      failureToolUseHooks: [],
      permissionDecisionHooks: [],
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    const autoFixHook: PostToolUseHook = () => ({ kind: "continue" });
    const config = {
      ...defaultConfig(),
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                type: "command" as const,
                command: "node -e 'process.exit(0)'",
              },
            ],
          },
        ],
      },
    };

    runtime.attachTarget(target);
    loadBootstrapHooks({
      hooksRuntime: runtime,
      hooksService: target,
      authoritySnapshot: { config, layers: [] },
      autoFixPostToolHook: autoFixHook,
    });
    expect(target.postToolUseHooks).toHaveLength(2);
    expect(target.postToolUseHooks.at(-1)).toBe(autoFixHook);

    loadBootstrapHooks({
      hooksRuntime: runtime,
      hooksService: target,
      authoritySnapshot: { config, layers: [] },
      autoFixPostToolHook: autoFixHook,
    });
    expect(target.postToolUseHooks).toHaveLength(2);
    expect(
      target.postToolUseHooks.filter((hook) => hook === autoFixHook),
    ).toHaveLength(1);

    loadBootstrapHooks({
      hooksRuntime: runtime,
      hooksService: target,
      authoritySnapshot: {
        config: { ...defaultConfig(), hooks: undefined },
        layers: [],
      },
      autoFixPostToolHook: autoFixHook,
    });
    expect(target.postToolUseHooks).toEqual([autoFixHook]);
  });

  test("preserves the built-in post hook while config and plugin hooks are replaced", () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: process.cwd(),
      env: process.env,
      agencHome: "/tmp/agenc-bootstrap-hook-authority-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
      sandboxExecutionBroker: explicitDangerBroker,
      executionAuthority: TRUSTED_HOOK_EXECUTION_AUTHORITY,
    });
    const target: HookInstallTarget = {
      preToolUseHooks: [],
      postToolUseHooks: [],
      failureToolUseHooks: [],
      permissionDecisionHooks: [],
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    const autoFixHook: PostToolUseHook = () => ({ kind: "continue" });
    const initialConfigCommand = "node -e 'process.exit(10)'";
    const replacementConfigCommand = "node -e 'process.exit(11)'";
    const initialPluginCommand = "node -e 'process.exit(12)'";
    const replacementPluginCommand = "node -e 'process.exit(13)'";

    runtime.attachTarget(target);
    loadBootstrapHooks({
      hooksRuntime: runtime,
      hooksService: target,
      authoritySnapshot: {
        config: {
          ...defaultConfig(),
          hooks: {
            PostToolUse: [
              {
                hooks: [
                  {
                    type: "command" as const,
                    command: initialConfigCommand,
                  },
                ],
              },
            ],
          },
        },
        layers: [],
      },
      autoFixPostToolHook: autoFixHook,
    });
    runtime.setPluginHooks({
      PostToolUse: [
        {
          hooks: [
            { type: "command" as const, command: initialPluginCommand },
          ],
        },
      ],
    });

    loadBootstrapHooks({
      hooksRuntime: runtime,
      hooksService: target,
      authoritySnapshot: {
        config: {
          ...defaultConfig(),
          hooks: {
            PostToolUse: [
              {
                hooks: [
                  {
                    type: "command" as const,
                    command: replacementConfigCommand,
                  },
                ],
              },
            ],
          },
        },
        layers: [],
      },
      autoFixPostToolHook: autoFixHook,
    });
    runtime.setPluginHooks({
      PostToolUse: [
        {
          hooks: [
            { type: "command" as const, command: replacementPluginCommand },
          ],
        },
      ],
    });

    expect(runtime.listHooks().map((hook) => hook.command.command).sort()).toEqual(
      [replacementConfigCommand, replacementPluginCommand].sort(),
    );
    expect(target.postToolUseHooks).toHaveLength(3);
    expect(
      target.postToolUseHooks.filter((hook) => hook === autoFixHook),
    ).toHaveLength(1);
    expect(target.postToolUseHooks.at(-1)).toBe(autoFixHook);
  });

  test("preserves programmatic lifecycle hooks while managed hooks are replaced", async () => {
    const hooksService = createHooksService();
    const runtime = new ConfiguredHooksRuntime({
      cwd: process.cwd(),
      env: {},
      agencHome: "/tmp/agenc-bootstrap-lifecycle-authority-test",
      shellPath: "/bin/sh",
      admissionRequired: false,
      sandboxExecutionBroker: explicitDangerBroker,
      executionAuthority: TRUSTED_HOOK_EXECUTION_AUTHORITY,
    });
    const fired: string[] = [];
    const initialConfigCommand = "printf 'configured-initial'";
    const replacementConfigCommand = "printf 'configured-current'";
    const initialPluginCommand = "printf 'plugin-initial'";
    const replacementPluginCommand = "printf 'plugin-current'";

    hooksService.addPreCompactHook(() => {
      fired.push("programmatic");
      return {
        succeeded: true,
        output: "programmatic",
        command: "programmatic",
      };
    });
    runtime.attachTarget(hooksService);
    runtime.loadConfigAuthority({
      config: {
        ...defaultConfig(),
        hooks: {
          PreCompact: [
            {
              hooks: [
                {
                  type: "command" as const,
                  command: initialConfigCommand,
                },
              ],
            },
          ],
        },
      },
      layers: [],
    });
    runtime.setPluginHooks({
      PreCompact: [
        {
          hooks: [
            { type: "command" as const, command: initialPluginCommand },
          ],
        },
      ],
    });
    runtime.loadConfigAuthority({
      config: {
        ...defaultConfig(),
        hooks: {
          PreCompact: [
            {
              hooks: [
                {
                  type: "command" as const,
                  command: replacementConfigCommand,
                },
              ],
            },
          ],
        },
      },
      layers: [],
    });
    runtime.setPluginHooks({
      PreCompact: [
        {
          hooks: [
            { type: "command" as const, command: replacementPluginCommand },
          ],
        },
      ],
    });

    const result = (await hooksService.executePreCompact({
      hook_event_name: "PreCompact",
      session_id: "configured-hook-refresh-test",
      transcript_path: "/tmp/agenc-bootstrap-lifecycle-authority-test/transcript.jsonl",
      cwd: process.cwd(),
      trigger: "manual",
      custom_instructions: null,
    })) as { readonly newCustomInstructions?: string };

    expect(fired).toEqual(["programmatic"]);
    expect(result.newCustomInstructions?.split("\n\n")).toEqual([
      "programmatic",
      "configured-current",
      "plugin-current",
    ]);
    expect(runtime.listHooks().map((hook) => hook.command.command).sort()).toEqual(
      [replacementConfigCommand, replacementPluginCommand].sort(),
    );
  });
});

describe("execution admission journal projection", () => {
  function catchupEvent(sequence: number): AdmissionJournalEvent {
    return {
      sequence,
      eventId: `catchup-${sequence}`,
      timestamp: "2026-07-18T00:00:00.000Z",
      runId: "run-catchup",
      stepId: `model-${sequence}`,
      kind: "model_turn",
      event: "queued",
    };
  }

  test("persists live admission decisions through the session event stream", () => {
    let listener: ((event: AdmissionJournalEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const admission = {
      subscribe: vi.fn((next: (event: AdmissionJournalEvent) => void) => {
        listener = next;
        return unsubscribe;
      }),
    } as unknown as ExecutionAdmissionClient;
    const emit = vi.fn();
    const session = {
      nextInternalSubId: () => "admission-event-1",
      emit,
    } as unknown as Session;
    const stop = bindExecutionAdmissionJournal(session, admission);
    const event: AdmissionJournalEvent = {
      sequence: 7,
      eventId: "journal-7",
      timestamp: "2026-07-18T00:00:00.000Z",
      runId: "run-1",
      stepId: "model-1",
      kind: "model_turn",
      event: "reconciled",
      reservationId: "reservation-1",
      actualTokens: 42,
      actualCostUsd: 0.01,
    };

    listener?.(event);

    expect(emit).toHaveBeenCalledWith(
      {
        eventId: "journal-7",
        id: "journal-7",
        msg: { type: "execution_admission", payload: event },
      },
      { durable: true },
    );
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("converges pre-bind and detached admission history without duplicate identities", () => {
    const history: AdmissionJournalEvent[] = [];
    let criticalListener: ((event: AdmissionJournalEvent) => void) | undefined;
    const subscribe = vi.fn(() => () => {});
    const subscribeCritical = vi.fn(
      (next: (event: AdmissionJournalEvent) => void) => {
        criticalListener = next;
        return () => {
          criticalListener = undefined;
        };
      },
    );
    const admission = {
      subscribe,
      subscribeCritical,
      replayJournal: vi.fn(({ afterSequence = 0, limit = 1_000 } = {}) =>
        history
          .filter((event) => event.sequence > afterSequence)
          .slice(0, limit),
      ),
    } as unknown as ExecutionAdmissionClient;
    const rolloutItems: Array<{
      readonly type: "event_msg";
      readonly payload: Event;
    }> = [];
    const readAll = vi.fn(() => rolloutItems);
    const syncCanonicalTail = vi.fn();
    let sequence = 0;
    const emit = vi.fn((event: Event): Event => {
      const stamped = { ...event, seq: ++sequence };
      rolloutItems.push({ type: "event_msg", payload: stamped });
      return stamped;
    });
    const session = {
      rolloutStore: { readAll, syncCanonicalTail },
      emit,
    } as unknown as Session;
    const admissionEvent = (
      journalSequence: number,
    ): AdmissionJournalEvent => ({
      sequence: journalSequence,
      eventId: `journal-${journalSequence}`,
      timestamp: `2026-07-18T00:00:0${journalSequence}.000Z`,
      runId: "run-1",
      stepId: `model-${journalSequence}`,
      kind: "model_turn",
      event: "reconciled",
      reservationId: `reservation-${journalSequence}`,
      actualTokens: journalSequence,
      actualCostUsd: 0,
    });

    history.push(admissionEvent(1));
    const stopFirstBinding = bindExecutionAdmissionJournal(session, admission);
    history.push(admissionEvent(2));
    criticalListener?.(history[1]!);
    stopFirstBinding();

    // Sequence 3 commits while no Session is attached. Rebinding scans the
    // SQLite journal from the beginning and idempotently fills only the gap.
    history.push(admissionEvent(3));
    const stopSecondBinding = bindExecutionAdmissionJournal(session, admission);

    expect(rolloutItems.map((item) => item.payload.eventId)).toEqual([
      "journal-1",
      "journal-2",
      "journal-3",
    ]);
    expect(new Set(rolloutItems.map((item) => item.payload.eventId)).size).toBe(
      3,
    );
    expect(emit).toHaveBeenCalledTimes(3);
    expect(subscribeCritical).toHaveBeenCalledTimes(2);
    expect(subscribe).not.toHaveBeenCalled();
    expect(readAll).toHaveBeenCalledOnce();
    expect(syncCanonicalTail).toHaveBeenCalledTimes(2);
    stopSecondBinding();
  });

  test("re-fsyncs matching admission bytes after an ambiguous append failure", () => {
    const event: AdmissionJournalEvent = {
      sequence: 1,
      eventId: "journal-ambiguous",
      timestamp: "2026-07-18T00:00:01.000Z",
      runId: "run-ambiguous",
      stepId: "model-1",
      kind: "model_turn",
      event: "queued",
    };
    const rolloutItems: Array<{
      readonly type: "event_msg";
      readonly payload: Event;
    }> = [];
    const syncCanonicalTail = vi.fn();
    const unsubscribe = vi.fn();
    const admission = {
      subscribeCritical: vi.fn(() => unsubscribe),
      subscribe: vi.fn(() => () => {}),
      replayJournal: vi.fn(() => [event]),
    } as unknown as ExecutionAdmissionClient;
    const session = {
      rolloutStore: {
        readAll: () => rolloutItems,
        syncCanonicalTail,
      },
      emit: (candidate: Event): Event => {
        const stamped = { ...candidate, seq: 1 };
        rolloutItems.push({ type: "event_msg", payload: stamped });
        throw new Error("injected post-write fsync ambiguity");
      },
    } as unknown as Session;

    const stop = bindExecutionAdmissionJournal(session, admission);

    expect(syncCanonicalTail).toHaveBeenCalledOnce();
    expect(rolloutItems).toHaveLength(1);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test("fails closed when a custom catch-up client returns a no-progress page", () => {
    const repeated = catchupEvent(1);
    const unsubscribe = vi.fn();
    const admission = {
      subscribeCritical: vi.fn(() => unsubscribe),
      subscribe: vi.fn(() => () => {}),
      replayJournal: vi.fn(() => Array.from({ length: 1_000 }, () => repeated)),
    } as unknown as ExecutionAdmissionClient;
    const emit = vi.fn();
    const session = { emit } as unknown as Session;

    expect(() => bindExecutionAdmissionJournal(session, admission)).toThrow(
      "execution admission catch-up made no monotonic progress after sequence 1",
    );
    expect(emit).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test("fails closed when custom admission catch-up exceeds the total work cap", () => {
    const unsubscribe = vi.fn();
    const replayJournal = vi.fn(
      ({ afterSequence = 0 }: { readonly afterSequence?: number } = {}) =>
        Array.from({ length: 1_000 }, (_, index) =>
          catchupEvent(afterSequence + index + 1),
        ),
    );
    const admission = {
      subscribeCritical: vi.fn(() => unsubscribe),
      subscribe: vi.fn(() => () => {}),
      replayJournal,
    } as unknown as ExecutionAdmissionClient;
    let emitted = 0;
    const session = {
      emit: (event: Event): Event => {
        emitted += 1;
        return event;
      },
    } as unknown as Session;

    expect(() => bindExecutionAdmissionJournal(session, admission)).toThrow(
      "execution admission catch-up exceeded 100000 events",
    );
    expect(emitted).toBe(100_000);
    expect(replayJournal).toHaveBeenCalledTimes(101);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("SessionStart bootstrap hooks", () => {
  async function bootstrapWithHooks(opts: {
    readonly hooks: NonNullable<ReturnType<typeof defaultConfig>["hooks"]>;
    readonly resume?: boolean;
  }) {
    mockPolicyLimits();
    const home = mkdtempSync(join(tmpdir(), "agenc-sessionstart-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "agenc-sessionstart-ws-"));
    mkdirSync(join(workspace, ".git"));
    // SessionStart command hooks now require a trusted workspace (production
    // establishes trust before bootstrap dispatches them); mark it trusted.
    trustProjectSync({ cwd: workspace, agencHome: home });
    const config = {
      ...defaultConfig(),
      agentRoles: [],
      hooks: opts.hooks,
    };
    const sessionConfiguration = {
      cwd: workspace,
      approvalPolicy: { value: "never" },
      sandboxPolicy: { value: "read_only" },
      fileSystemSandboxPolicy: {
        allowWrite: [],
        denyWrite: [],
        allowRead: [],
        denyRead: [],
      },
      networkSandboxPolicy: {
        allowlist: [],
        denylist: [],
        allowManagedDomainsOnly: false,
      },
      windowsSandboxLevel: "none",
      collaborationMode: { model: "test-model" },
      dynamicTools: [],
      sessionSource: "cli_main",
      permissionContext: { mode: "default" },
    };
    const handle = buildBootstrapSessionServices({
      provider: {
        name: "anthropic",
        chat: async () => ({
          content: "ok",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }),
        chatStream: async () => ({
          content: "ok",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }),
        healthCheck: async () => true,
      },
      providerName: "anthropic",
      registry: { tools: [] } as never,
      mcpManager: {} as never,
      unifiedExecManager: {} as never,
      sandboxExecutionBroker: explicitDangerBroker,
      permissionModeRegistry: new PermissionModeRegistry(
        createEmptyToolPermissionContext(),
      ),
      configStore: {
        current: () => config,
        authoritySnapshot: () => ({ config, layers: [] }),
        subscribe: () => () => {},
        projectRoot: workspace,
      } as never,
      toolApprovals: {
        get: () => undefined,
        set: () => {},
        clear: () => {},
        withCachedApproval: async (request: {
          fetchDecision: () => Promise<unknown>;
        }) => request.fetchDecision(),
      } as never,
      networkApproval: {
        clearSessionHosts: () => {},
        requestNetworkApproval: async () => ({ kind: "approved" }),
        requestDeferredApproval: async () => ({ kind: "approved" }),
      } as never,
      modelsManager: {} as never,
      agencHome: home,
      workspaceRoot: workspace,
      // The SessionStart hooks below shell out to `node -e ...`, and
      // command-runner spawns with exactly this env (`env: command.env`, never
      // merged with process.env). Without PATH the shell cannot resolve node,
      // the hook produces no stdout, and the dispatch returns zero messages --
      // which reads as "hooks never fired" rather than "the hook could not
      // run at all".
      env: {
        HOME: home,
        SHELL: "/bin/sh",
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      },
      conversationId: "session-sessionstart",
      model: "test-model",
      sessionConfiguration: sessionConfiguration as never,
      runtimeOptions: TEST_RUNTIME_OPTIONS,
      commandExecutionAuthority: TEST_COMMAND_EXECUTION_AUTHORITY,
      admissionRequired: false,
    });
    const session = await bootstrapSession({
      conversationId: "session-sessionstart",
      initialState: {
        sessionConfiguration: sessionConfiguration as never,
        history: [],
        ...(opts.resume
          ? { pendingSessionStartSource: "resume" as const }
          : {}),
      },
      features: config.features,
      services: handle.services,
      jsRepl: { id: "repl-sessionstart" },
      config,
      modelInfo: {
        slug: "test-model",
        effectiveContextWindowPercent: 100,
        contextWindow: 1024,
        supportedReasoningLevels: [],
        defaultReasoningSummary: "auto",
        truncationPolicy: "off",
        usedFallbackModelMetadata: false,
      },
      enablePrewarm: false,
      sessionConfigured: {
        sessionId: "session-sessionstart",
        model: "test-model",
        modelProviderId: "anthropic",
        cwd: workspace,
        historyLogId: 0,
        historyEntryCount: 0,
        initialMessages: [],
      },
    });
    return { handle, home, workspace, session };
  }

  test("dispatches SessionStart once with live startup context", async () => {
    const env = await bootstrapWithHooks({
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [{ type: "command", command: sessionStartEchoCommand() }],
          },
        ],
      },
    });
    try {
      const events = drainSessionEvents(env.session as never);
      const sessionStartContexts = events.filter(
        (event) =>
          (event as { msg?: { type?: string } }).msg?.type ===
          "hook_additional_context",
      );
      expect(sessionStartContexts).toHaveLength(1);
      expect(sessionStartContexts[0]).toMatchObject({
        msg: {
          type: "hook_additional_context",
          hookEvent: "SessionStart",
          content: ["source=startup;model=test-model;mode=default"],
        },
      });
    } finally {
      await env.handle.shutdown();
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.workspace, { recursive: true, force: true });
    }
  });

  test("uses resume source and surfaces stopped-continuation output without aborting bootstrap", async () => {
    const env = await bootstrapWithHooks({
      resume: true,
      hooks: {
        SessionStart: [
          {
            matcher: "resume",
            hooks: [{ type: "command", command: sessionStartStopCommand() }],
          },
        ],
      },
    });
    try {
      const events = drainSessionEvents(env.session as never);
      expect(events).toContainEqual(
        expect.objectContaining({
          msg: expect.objectContaining({
            type: "hook_stopped_continuation",
            hookEvent: "SessionStart",
            message: "pause startup",
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          msg: expect.objectContaining({
            type: "hook_additional_context",
            hookEvent: "SessionStart",
            content: ["startup context"],
          }),
        }),
      );
    } finally {
      await env.handle.shutdown();
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.workspace, { recursive: true, force: true });
    }
  });
});

describe("buildBootstrapSessionServices policy limits wiring", () => {
  test("initializes policy limits and stops polling on shutdown", async () => {
    const stopBackgroundPolling = vi.fn();
    const policyLimits = {
      initializePolicyLimitsLoadingPromise: vi.fn(),
      loadPolicyLimits: vi.fn(async () => {}),
      stopBackgroundPolling,
    };
    policyLimitsMocks.configurePolicyLimitsService.mockReturnValue(
      policyLimits as never,
    );
    const home = mkdtempSync(join(tmpdir(), "agenc-policy-bootstrap-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "agenc-policy-bootstrap-ws-"));
    try {
      const handle = buildBootstrapSessionServices({
        provider: createProvider("anthropic", {
          apiKey: "direct-policy-key",
          model: "claude-opus-4-7",
        }),
        providerName: "anthropic",
        registry: { tools: [] } as never,
        mcpManager: {} as never,
        unifiedExecManager: {} as never,
        sandboxExecutionBroker: explicitDangerBroker,
        permissionModeRegistry: new PermissionModeRegistry(
          createEmptyToolPermissionContext(),
        ),
        configStore: {
          current: () => defaultConfig(),
          authoritySnapshot: () => ({ config: defaultConfig(), layers: [] }),
          subscribe: () => () => {},
        } as never,
        toolApprovals: {
          get: () => undefined,
          set: () => {},
          clear: () => {},
          withCachedApproval: async (request: {
            fetchDecision: () => Promise<unknown>;
          }) => request.fetchDecision(),
        } as never,
        networkApproval: {
          clearSessionHosts: () => {},
          requestNetworkApproval: async () => ({ kind: "approved" }),
          requestDeferredApproval: async () => ({ kind: "approved" }),
        } as never,
        modelsManager: {} as never,
        agencHome: home,
        workspaceRoot: workspace,
        env: { HOME: home, SHELL: "/bin/sh" },
        conversationId: "session-policy-bootstrap",
        model: "agenc-opus-4-7",
        sessionConfiguration: {} as never,
        runtimeOptions: TEST_RUNTIME_OPTIONS,
        commandExecutionAuthority: TEST_COMMAND_EXECUTION_AUTHORITY,
      });

      expect(
        policyLimitsMocks.configurePolicyLimitsService,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          agencHome: home,
          providerName: "anthropic",
          apiKey: "direct-policy-key",
          sessionId: "session-policy-bootstrap",
        }),
      );
      expect(
        policyLimits.initializePolicyLimitsLoadingPromise,
      ).toHaveBeenCalled();
      expect(policyLimits.loadPolicyLimits).toHaveBeenCalled();
      expect(handle.services.policyLimits).toBe(policyLimits);

      await handle.shutdown();

      expect(stopBackgroundPolling).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects a concurrent mode mutation before applying a reloaded permission generation", async () => {
    mockPolicyLimits();
    const home = mkdtempSync(join(tmpdir(), "agenc-permission-reload-home-"));
    const workspace = mkdtempSync(
      join(tmpdir(), "agenc-permission-reload-workspace-"),
    );
    const configPath = join(home, "config.toml");
    writeFileSync(configPath, "config_version = 2\n", "utf8");
    const configStore = new ConfigStore({
      home,
      cwd: workspace,
      projectRoot: workspace,
      projectTrusted: true,
      env: { AGENC_HOME: home, HOME: home },
    });
    await configStore.reload();
    const permissionModeRegistry = new PermissionModeRegistry(
      createEmptyToolPermissionContext(),
    );
    let releaseModeChange = (): void => {};
    let removeFailureHook = (): void => {};
    let handle: ReturnType<typeof buildBootstrapSessionServices> | undefined;
    try {
      handle = buildBootstrapSessionServices({
        provider: {
          name: "anthropic",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          }),
          chatStream: async () => ({
            content: "ok",
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          }),
          healthCheck: async () => true,
        },
        providerName: "anthropic",
        registry: { tools: [] } as never,
        mcpManager: {} as never,
        unifiedExecManager: {} as never,
        sandboxExecutionBroker: explicitDangerBroker,
        permissionModeRegistry,
        configStore,
        toolApprovals: {
          get: () => undefined,
          set: () => {},
          clear: () => {},
          withCachedApproval: async (request: {
            fetchDecision: () => Promise<unknown>;
          }) => request.fetchDecision(),
        } as never,
        networkApproval: {
          clearSessionHosts: () => {},
          requestNetworkApproval: async () => ({ kind: "approved" }),
          requestDeferredApproval: async () => ({ kind: "approved" }),
        } as never,
        modelsManager: {} as never,
        agencHome: home,
        workspaceRoot: workspace,
        env: { HOME: home, SHELL: "/bin/sh" },
        conversationId: "session-permission-reload",
        model: "test-model",
        sessionConfiguration: {} as never,
        runtimeOptions: TEST_RUNTIME_OPTIONS,
        commandExecutionAuthority: TEST_COMMAND_EXECUTION_AUTHORITY,
        admissionRequired: false,
      });

      let markModeChangeStarted!: () => void;
      const modeChangeStarted = new Promise<void>((resolve) => {
        markModeChangeStarted = resolve;
      });
      const modeChangeGate = new Promise<void>((resolve) => {
        releaseModeChange = resolve;
      });
      const modeChange = permissionModeRegistry.transact(async (current) => {
        markModeChangeStarted();
        await modeChangeGate;
        return {
          next: { ...current, mode: "plan" },
          result: () => undefined,
        };
      });
      await modeChangeStarted;

      writeFileSync(
        configPath,
        [
          "config_version = 2",
          "[permissions]",
          'deny = ["system.bash(rm:*)"]',
          "",
        ].join("\n"),
        "utf8",
      );
      await configStore.reload();
      releaseModeChange();
      await expect(modeChange).rejects.toBeInstanceOf(
        PermissionAuthorityUnavailableError,
      );

      await vi.waitFor(() => {
        expect(permissionModeRegistry.current()).toMatchObject({
          mode: "default",
          alwaysDenyRules: {
            userSettings: ["system.bash(rm:*)"],
          },
        });
      });
      expect(Object.isFrozen(permissionModeRegistry.current())).toBe(true);

      const failedPublication = Promise.withResolvers<void>();
      removeFailureHook = permissionModeRegistry.installBeforeUpdateHook(() => {
        failedPublication.resolve();
        throw new Error("injected permission reload durability failure");
      });
      writeFileSync(
        configPath,
        [
          "config_version = 2",
          "[permissions]",
          'deny = ["system.bash(curl:*)"]',
          "",
        ].join("\n"),
        "utf8",
      );
      await configStore.reload();
      await failedPublication.promise;

      expect(configStore.current().permissions?.deny).toEqual([
        "system.bash(curl:*)",
      ]);
      expect(() => permissionModeRegistry.current()).toThrow(
        PermissionAuthorityUnavailableError,
      );
      expect(() => handle!.execPolicy.current()).toThrow(
        PermissionAuthorityUnavailableError,
      );

      removeFailureHook();
      removeFailureHook = (): void => {};
      await configStore.reload();
      await vi.waitFor(() => {
        expect(permissionModeRegistry.current()).toMatchObject({
          mode: "default",
          alwaysDenyRules: {
            userSettings: ["system.bash(curl:*)"],
          },
        });
      });
      expect(Object.isFrozen(permissionModeRegistry.current())).toBe(true);
    } finally {
      releaseModeChange();
      removeFailureHook();
      await handle?.shutdown();
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("does not re-enter permission publication for a registry-coordinated config reload", async () => {
    mockPolicyLimits();
    const home = mkdtempSync(join(tmpdir(), "agenc-coordinated-reload-home-"));
    const workspace = mkdtempSync(
      join(tmpdir(), "agenc-coordinated-reload-workspace-"),
    );
    const configPath = join(home, "config.toml");
    writeFileSync(configPath, "config_version = 2\n", "utf8");
    const configStore = new ConfigStore({
      home,
      cwd: workspace,
      projectRoot: workspace,
      projectTrusted: true,
      env: { AGENC_HOME: home, HOME: home },
    });
    await configStore.reload();
    const permissionModeRegistry = new PermissionModeRegistry(
      createEmptyToolPermissionContext(),
    );
    let handle: ReturnType<typeof buildBootstrapSessionServices> | undefined;
    let removeCoordinator = (): void => {};
    try {
      handle = buildBootstrapSessionServices({
        provider: {
          name: "anthropic",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          }),
          chatStream: async () => ({
            content: "ok",
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          }),
          healthCheck: async () => true,
        },
        providerName: "anthropic",
        registry: { tools: [] } as never,
        mcpManager: {} as never,
        unifiedExecManager: {} as never,
        sandboxExecutionBroker: explicitDangerBroker,
        permissionModeRegistry,
        configStore,
        toolApprovals: {
          get: () => undefined,
          set: () => {},
          clear: () => {},
          withCachedApproval: async (request: {
            fetchDecision: () => Promise<unknown>;
          }) => request.fetchDecision(),
        } as never,
        networkApproval: {
          clearSessionHosts: () => {},
          requestNetworkApproval: async () => ({ kind: "approved" }),
          requestDeferredApproval: async () => ({ kind: "approved" }),
        } as never,
        modelsManager: {} as never,
        agencHome: home,
        workspaceRoot: workspace,
        env: { HOME: home, SHELL: "/bin/sh" },
        conversationId: "session-coordinated-permission-reload",
        model: "test-model",
        sessionConfiguration: {} as never,
        runtimeOptions: TEST_RUNTIME_OPTIONS,
        commandExecutionAuthority: TEST_COMMAND_EXECUTION_AUTHORITY,
        admissionRequired: false,
      });

      const contextPublications = vi.fn();
      permissionModeRegistry.subscribeToContextChange(contextPublications);
      removeCoordinator = permissionModeRegistry.installPublicationCoordinator(
        async (_next, _current, metadata, publication) => {
          const prepared = (
            metadata as {
              readonly preparedConfigReload: PreparedConfigStoreReload;
            }
          ).preparedConfigReload;
          prepared.commit();
          await publication.commit();
          prepared.publish(COORDINATED_CONFIG_STORE_PUBLICATION);
          prepared.settle();
        },
      );

      writeFileSync(
        configPath,
        [
          "config_version = 2",
          "[permissions]",
          'deny = ["system.bash(curl:*)"]',
          "",
        ].join("\n"),
        "utf8",
      );
      const preparedConfigReload = await configStore.prepareReload();
      const permissionSnapshot = readPermissionRulesSnapshot(
        preparedConfigReload.authority,
      );
      await permissionModeRegistry.transact((current) => ({
        next: applyPermissionRulesSnapshot(current, permissionSnapshot),
        metadata: { preparedConfigReload },
        result: () => undefined,
      }));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(permissionModeRegistry.current().alwaysDenyRules).toMatchObject({
        userSettings: ["system.bash(curl:*)"],
      });
      expect(contextPublications).toHaveBeenCalledOnce();
    } finally {
      removeCoordinator();
      await handle?.shutdown();
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("exposes a live LSP refresh service", async () => {
    _resetLspManagerForTesting();
    const stopBackgroundPolling = vi.fn();
    const policyLimits = {
      initializePolicyLimitsLoadingPromise: vi.fn(),
      loadPolicyLimits: vi.fn(async () => {}),
      stopBackgroundPolling,
    };
    policyLimitsMocks.configurePolicyLimitsService.mockReturnValue(
      policyLimits as never,
    );
    const home = mkdtempSync(join(tmpdir(), "agenc-lsp-refresh-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "agenc-lsp-refresh-ws-"));
    const marker = join(workspace, "lsp-escaped");
    const sandboxExecutionBroker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: workspace,
      probe: () => ({
        kind: "unavailable",
        mode: "workspace_write",
        platform: process.platform,
        reason: "probe: injected bootstrap LSP namespace failure",
        remediation: "repair sandbox support",
      }),
    });
    const handle = buildBootstrapSessionServices({
      provider: {
        name: "anthropic",
        chat: async () => ({
          content: "ok",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }),
        chatStream: async () => ({
          content: "ok",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }),
        healthCheck: async () => true,
      },
      providerName: "anthropic",
      registry: { tools: [] } as never,
      mcpManager: {} as never,
      unifiedExecManager: {} as never,
      sandboxExecutionBroker,
      permissionModeRegistry: new PermissionModeRegistry(
        createEmptyToolPermissionContext(),
      ),
      configStore: {
        current: () => defaultConfig(),
        authoritySnapshot: () => ({ config: defaultConfig(), layers: [] }),
        subscribe: () => () => {},
      } as never,
      toolApprovals: {
        get: () => undefined,
        set: () => {},
        clear: () => {},
        withCachedApproval: async (request: {
          fetchDecision: () => Promise<unknown>;
        }) => request.fetchDecision(),
      } as never,
      networkApproval: {
        clearSessionHosts: () => {},
        requestNetworkApproval: async () => ({ kind: "approved" }),
        requestDeferredApproval: async () => ({ kind: "approved" }),
      } as never,
      modelsManager: {} as never,
      agencHome: home,
      workspaceRoot: workspace,
      env: { HOME: home, SHELL: "/bin/sh" },
      conversationId: "session-lsp-refresh",
      model: "agenc-opus-4-7",
      sessionConfiguration: {} as never,
      runtimeOptions: TEST_RUNTIME_OPTIONS,
      commandExecutionAuthority: TEST_COMMAND_EXECUTION_AUTHORITY,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));

      await handle.services.lspManager?.refreshFromConfig({
        ...defaultConfig(),
        lsp_servers: {
          ts: {
            command: process.execPath,
            args: [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "escaped")`,
            ],
            extensionToLanguage: { ".ts": "typescript" },
          },
        },
      });
      await waitForInitialization(sandboxExecutionBroker);

      expect(getInitializationStatus(sandboxExecutionBroker).status).toBe(
        "success",
      );
      const manager = getLspServerManager(sandboxExecutionBroker);
      expect(manager?.getAllServers().has("ts")).toBe(true);
      if (manager === undefined)
        throw new Error("LSP manager was not initialized");
      await expect(
        manager.ensureServerStarted(join(workspace, "file.ts")),
      ).rejects.toMatchObject({
        code: "sandbox_probe_failed",
        surface: "lsp",
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await handle.shutdown();
      await shutdownLspServerManager(sandboxExecutionBroker);
      _resetLspManagerForTesting();
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("loadBootstrapLspServers", () => {
  function rejectingStopServer(): LSPServerInstance {
    const config = normalizeLspServerConfig("ts", {
      command: "typescript-language-server",
      extensionToLanguage: { ".ts": "typescript" },
    });
    return {
      name: "ts",
      config,
      get state() {
        return "running";
      },
      get startTime() {
        return undefined;
      },
      get lastError() {
        return undefined;
      },
      get restartCount() {
        return 0;
      },
      start: async () => {},
      stop: async () => {
        throw new Error("stop failed");
      },
      restart: async () => {},
      isHealthy: () => true,
      sendRequest: async () => ({}),
      sendNotification: async () => {},
      onNotification: () => {},
      onRequest: () => {},
    } as unknown as LSPServerInstance;
  }

  test("starts and stops the LSP manager from typed config", async () => {
    _resetLspManagerForTesting();
    try {
      await loadBootstrapLspServers(
        {
          ...defaultConfig(),
          lsp_servers: {
            ts: {
              command: "typescript-language-server",
              extensionToLanguage: { ".ts": "typescript" },
            },
          },
        },
        { workspaceRoot: "/workspace/project" },
      );
      expect(getInitializationStatus().status).toBe("pending");
      await waitForInitialization();
      expect(getInitializationStatus().status).toBe("success");
      expect(getLspServerManager()?.getAllServers().has("ts")).toBe(true);

      await loadBootstrapLspServers(
        { ...defaultConfig(), lsp_servers: undefined },
        { workspaceRoot: "/workspace/project" },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getInitializationStatus().status).toBe("not-started");

      await loadBootstrapLspServers(
        { ...defaultConfig(), lsp_servers: undefined },
        { workspaceRoot: "/workspace/project" },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getInitializationStatus().status).toBe("not-started");
    } finally {
      await shutdownLspServerManager();
      _resetLspManagerForTesting();
    }
  });

  test("empty LSP config clears stale non-empty source", async () => {
    _resetLspManagerForTesting();
    try {
      await loadBootstrapLspServers(
        {
          ...defaultConfig(),
          lsp_servers: {
            ts: {
              command: "typescript-language-server",
              extensionToLanguage: { ".ts": "typescript" },
            },
          },
        },
        { workspaceRoot: "/workspace/project" },
      );
      await waitForInitialization();
      expect(getLspServerManager()?.getAllServers().has("ts")).toBe(true);

      await loadBootstrapLspServers(
        { ...defaultConfig(), lsp_servers: {} },
        { workspaceRoot: "/workspace/project" },
      );
      expect(getInitializationStatus().status).toBe("not-started");
      initializeLspServerManager({ workspaceRoot: "/workspace/project" });
      await waitForInitialization();
      expect(getInitializationStatus().status).toBe("success");
      expect(getLspServerManager()?.getAllServers().size).toBe(0);
      await shutdownLspServerManager();

      await loadBootstrapLspServers(
        {
          ...defaultConfig(),
          lsp_servers: {
            broken: {
              command: "",
              extensionToLanguage: {},
            },
          },
        },
        { workspaceRoot: "/workspace/project" },
      );
      await waitForInitialization();
      expect(getInitializationStatus().status).toBe("failed");

      await loadBootstrapLspServers(
        { ...defaultConfig(), lsp_servers: undefined },
        { workspaceRoot: "/workspace/project" },
      );
      expect(getInitializationStatus().status).toBe("not-started");
      initializeLspServerManager({ workspaceRoot: "/workspace/project" });
      await waitForInitialization();
      expect(getInitializationStatus().status).toBe("success");
      expect(getLspServerManager()?.getAllServers().size).toBe(0);
    } finally {
      await shutdownLspServerManager();
      _resetLspManagerForTesting();
    }
  });

  test("surfaces invalid LSP config as initialization failure", async () => {
    _resetLspManagerForTesting();
    try {
      await loadBootstrapLspServers(
        {
          ...defaultConfig(),
          lsp_servers: {
            broken: {
              command: "",
              extensionToLanguage: {},
            },
          },
        },
        { workspaceRoot: "/workspace/project" },
      );
      await waitForInitialization();
      const status = getInitializationStatus();
      expect(status.status).toBe("failed");
      expect(status.status === "failed" ? status.error.message : "").toContain(
        "Invalid LSP server config",
      );
    } finally {
      await shutdownLspServerManager();
      _resetLspManagerForTesting();
    }
  });

  test("background config reload logs LSP shutdown rejection", async () => {
    _resetLspManagerForTesting();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = normalizeLspServerConfig("ts", {
      command: "typescript-language-server",
      extensionToLanguage: { ".ts": "typescript" },
    });
    try {
      initializeLspServerManager({
        configSource: () => ({ ts: config }),
        instanceFactory: () => rejectingStopServer(),
      });
      await waitForInitialization();

      loadBootstrapLspServersInBackground(
        { ...defaultConfig(), lsp_servers: undefined },
        { workspaceRoot: "/workspace/project" },
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(warn).toHaveBeenCalledWith(
        "[lsp] bootstrap config reload failed:",
        expect.stringContaining("stop failed"),
      );
    } finally {
      warn.mockRestore();
      _resetLspManagerForTesting();
    }
  });

  test("bootstrap LSP shutdown logs and does not throw on stop failure", async () => {
    _resetLspManagerForTesting();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = normalizeLspServerConfig("ts", {
      command: "typescript-language-server",
      extensionToLanguage: { ".ts": "typescript" },
    });
    try {
      initializeLspServerManager({
        configSource: () => ({ ts: config }),
        instanceFactory: () => rejectingStopServer(),
      });
      await waitForInitialization();

      await expect(shutdownBootstrapLspServers()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "[lsp] bootstrap shutdown failed:",
        expect.stringContaining("stop failed"),
      );
    } finally {
      warn.mockRestore();
      _resetLspManagerForTesting();
    }
  });
});
