import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resetStateForTests,
  registerHookCallbacks,
  setCwdState,
  setIsInteractive,
  setMainThreadAgentType,
  setOriginalCwd,
  setSessionTrustAccepted,
  switchSession,
} from "../../src/bootstrap/state.js";
import {
  createBaseHookInput,
  executeConfigChangeHooks,
  executeCwdChangedHooks,
  executeElicitationHooks,
  executeElicitationResultHooks,
  executeFileSuggestionCommand,
  executeInstructionsLoadedHooks,
  executePermissionRequestHooks,
  executeNotificationHooks,
  executeSessionEndHooks,
  executeStatusLineCommand,
  executeStopHooks,
  executeSubagentStartHooks,
  executeTaskCompletedHooks,
  executeTaskCreatedHooks,
  executeTeammateIdleHooks,
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  getSessionEndHookTimeoutMs,
  getStopHookMessage,
  getTaskCompletedHookMessage,
  getTaskCreatedHookMessage,
  getTeammateIdleHookMessage,
  getMatchingHooks,
  hasBlockingResult,
  hasInstructionsLoadedHook,
  hasWorktreeCreateHook,
  matchesPattern,
} from "../../src/utils/hooks.js";
import type { Message } from "../../src/types/message.js";
import {
  clearCurrentRuntimeSession,
  getCurrentRuntimeSession,
  runWithCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "../../src/session/current-session.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { createHookExecutionAuthority } from "../../src/hooks/execution-authority.js";
import { SessionProviderService } from "../../src/session/provider-service.js";
import { ConfigStore } from "../../src/config/store.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";
import {
  getCommandQueueSnapshot,
  resetCommandQueueForTesting,
} from "../../src/utils/messageQueueManager.js";
import {
  checkForAsyncHookResponses,
  clearAllAsyncHooks,
  getPendingAsyncHooks,
  registerPendingAsyncHook,
} from "../../src/utils/hooks/AsyncHookRegistry.js";
import type { ShellCommand } from "../../src/utils/ShellCommand.js";

const tempDirs: string[] = [];
const sessionId = "00000000-0000-4000-8000-000000000901";
const originalAgenCHome = process.env.AGENC_HOME;
const originalSessionEndTimeout = process.env.AGENC_SESSIONEND_HOOKS_TIMEOUT_MS;
const originalAllowUntrustedHooks = process.env.AGENC_ALLOW_UNTRUSTED_HOOKS;
const hookCommandTimeoutMs = 5_000;

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function createHookProviderService(): SessionProviderService {
  return new SessionProviderService({
    initialProvider: { name: "stub-provider" } as never,
    initialProviderName: "grok",
    initialModel: "test-model",
    environment: {},
  });
}

async function configureHookSession(
  options: {
    readonly trusted?: boolean;
    readonly allowUntrustedCommands?: boolean;
  } = {},
): Promise<{
  agencHome: string;
  cwd: string;
}> {
  const agencHome = await mkdtemp(join(tmpdir(), "agenc-hooks-core-"));
  tempDirs.push(agencHome);
  process.env.AGENC_HOME = agencHome;
  resetStateForTests();
  clearCurrentRuntimeSession();
  const cwd = join(agencHome, "workspace");
  await mkdir(cwd, { recursive: true });
  const configStore = new ConfigStore({
    home: agencHome,
    env: { AGENC_HOME: agencHome },
    cwd,
  });
  const runtimeOptions = resolveAgentRuntimeOptions({}, {
    allowUntrustedHooks: options.allowUntrustedCommands ?? false,
  });
  setCurrentRuntimeSession({
    conversationId: sessionId,
    sessionConfiguration: { cwd },
    services: {
      sandboxExecutionBroker: explicitDangerBroker,
      admissionRequired: false,
      configStore,
      providerService: createHookProviderService(),
      runtimeOptions,
      userShell: {
        path: "/bin/sh",
        commandWrapperArgv: [],
        childEnvironment: { ...process.env },
        deriveExecArgs: (input: string) => ["-c", input],
      },
      hookExecutionAuthority: createHookExecutionAuthority({
        runtimeOptions,
        isWorkspaceTrusted: () => options.trusted ?? true,
      }),
    },
  } as never);

  setOriginalCwd(cwd);
  setCwdState(cwd);
  switchSession(sessionId as never, null);
  return { agencHome, cwd };
}

async function collectAsyncGenerator<T>(
  generator: AsyncGenerator<T>,
): Promise<T[]> {
  const results: T[] = [];
  for await (const result of generator) {
    results.push(result);
  }
  return results;
}

function toolUseContext(appState: { sessionHooks: Map<string, unknown> }) {
  return {
    getAppState: () => appState,
    abortController: new AbortController(),
    updateAttributionState: () => undefined,
  } as never;
}

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function stdoutCommand(output: string): string {
  return nodeCommand(`process.stdout.write(${JSON.stringify(output)})`);
}

function acceptInteractiveWorkspaceTrust(): void {
  setIsInteractive(true);
  setSessionTrustAccepted(true);
}

function bindHookSessionSimpleMode(simpleMode: boolean): void {
  const session = getCurrentRuntimeSession();
  if (session === null) throw new Error("Expected a configured hook session");
  clearCurrentRuntimeSession();
  const runtimeOptions = resolveAgentRuntimeOptions({}, { simpleMode });
  setCurrentRuntimeSession({
    ...session,
    services: {
      ...session.services,
      runtimeOptions,
      hookExecutionAuthority: createHookExecutionAuthority({
        runtimeOptions,
        isWorkspaceTrusted: () => true,
      }),
    },
  } as never);
}

function completedAsyncHookCommand(stdout: string): ShellCommand {
  return {
    background: () => false,
    result: Promise.resolve({
      stdout,
      stderr: "",
      code: 0,
      interrupted: false,
    }),
    kill: () => undefined,
    status: "completed",
    cleanup: () => undefined,
    taskOutput: {
      getStdout: async () => stdout,
      getStderr: () => "",
    },
  } as unknown as ShellCommand;
}

function registerCompletedAsyncHook(
  processId: string,
  conversationId: string,
): void {
  registerPendingAsyncHook({
    processId,
    hookId: `hook-${processId}`,
    asyncResponse: { async: true },
    hookName: `hook ${processId}`,
    hookEvent: "Stop",
    command: "printf response",
    shellCommand: completedAsyncHookCommand('{"continue":true}\n'),
    queueOwner: { kind: "session", conversationId },
  });
}

afterEach(async () => {
  resetCommandQueueForTesting();
  clearCurrentRuntimeSession();
  resetStateForTests();
  restoreOptionalEnv("AGENC_HOME", originalAgenCHome);
  restoreOptionalEnv(
    "AGENC_SESSIONEND_HOOKS_TIMEOUT_MS",
    originalSessionEndTimeout,
  );
  restoreOptionalEnv(
    "AGENC_ALLOW_UNTRUSTED_HOOKS",
    originalAllowUntrustedHooks,
  );
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("async rewake completion retains the session that launched the hook", async () => {
  await configureHookSession();
  acceptInteractiveWorkspaceTrust();
  const appState = { sessionHooks: new Map<string, unknown>() };
  registerHookCallbacks({
    Stop: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: nodeCommand(
              "setTimeout(() => { process.stderr.write('origin blocked'); process.exit(2); }, 150)",
            ),
            asyncRewake: true,
          },
        ],
      },
    ],
  } as never);

  await collectAsyncGenerator(
    executeStopHooks(
      "default",
      undefined,
      hookCommandTimeoutMs,
      false,
      undefined,
      toolUseContext(appState),
      [],
    ),
  );

  switchSession("00000000-0000-4000-8000-000000000902" as never, null);

  await vi.waitFor(() => {
    expect(getCommandQueueSnapshot()).toHaveLength(1);
  });
  expect(getCommandQueueSnapshot()[0]?.queueOwner).toEqual({
    kind: "session",
    conversationId: sessionId,
  });
});

test("async hook registry returns empty in bare mode without consuming pending work", async () => {
  await configureHookSession();
  clearAllAsyncHooks();
  registerCompletedAsyncHook("bare-pending", sessionId);
  const owner = { kind: "session" as const, conversationId: sessionId };

  try {
    bindHookSessionSimpleMode(true);
    expect(getPendingAsyncHooks(owner)).toEqual([]);
    await expect(checkForAsyncHookResponses(owner)).resolves.toEqual([]);

    bindHookSessionSimpleMode(false);
    expect(getPendingAsyncHooks(owner).map((hook) => hook.processId)).toEqual([
      "bare-pending",
    ]);
    await expect(checkForAsyncHookResponses(owner)).resolves.toMatchObject([
      { processId: "bare-pending" },
    ]);
  } finally {
    clearAllAsyncHooks();
  }
});

test("async hook registry filters pending hooks and responses by queue owner", async () => {
  await configureHookSession();
  bindHookSessionSimpleMode(false);
  clearAllAsyncHooks();
  registerCompletedAsyncHook("owner-a", "conversation-a");
  registerCompletedAsyncHook("owner-b", "conversation-b");
  const ownerA = {
    kind: "session" as const,
    conversationId: "conversation-a",
  };
  const ownerB = {
    kind: "session" as const,
    conversationId: "conversation-b",
  };

  try {
    expect(getPendingAsyncHooks(ownerA).map((hook) => hook.processId)).toEqual([
      "owner-a",
    ]);
    await expect(checkForAsyncHookResponses(ownerA)).resolves.toMatchObject([
      { processId: "owner-a" },
    ]);
    expect(getPendingAsyncHooks(ownerB).map((hook) => hook.processId)).toEqual([
      "owner-b",
    ]);
    await expect(checkForAsyncHookResponses(ownerB)).resolves.toMatchObject([
      { processId: "owner-b" },
    ]);
  } finally {
    clearAllAsyncHooks();
  }
});

test("parses session end hook timeout from the environment", () => {
  delete process.env.AGENC_SESSIONEND_HOOKS_TIMEOUT_MS;
  expect(getSessionEndHookTimeoutMs()).toBe(1500);

  process.env.AGENC_SESSIONEND_HOOKS_TIMEOUT_MS = "2500";
  expect(getSessionEndHookTimeoutMs()).toBe(2500);

  for (const value of ["0", "-1", "not-a-number"]) {
    process.env.AGENC_SESSIONEND_HOOKS_TIMEOUT_MS = value;
    expect(getSessionEndHookTimeoutMs()).toBe(1500);
  }
});

test("creates base hook input from session, cwd, permission, and agent state", async () => {
  const { agencHome, cwd } = await configureHookSession();
  setMainThreadAgentType("planner");

  const base = createBaseHookInput("acceptEdits");
  expect(base).toMatchObject({
    session_id: sessionId,
    cwd,
    permission_mode: "acceptEdits",
    agent_type: "planner",
  });
  expect(base.transcript_path).toContain(agencHome);
  expect(base.transcript_path.endsWith(`${sessionId}.jsonl`)).toBe(true);

  const other = createBaseHookInput(
    undefined,
    "00000000-0000-4000-8000-000000000902",
    {
      agentId: "agent-1",
      agentType: "runner",
    },
  );
  expect(other).toMatchObject({
    session_id: "00000000-0000-4000-8000-000000000902",
    agent_id: "agent-1",
    agent_type: "runner",
  });
});

test("matches hook patterns for wildcards, exact names, lists, regex, and rejected regex", () => {
  expect(matchesPattern("Write", "")).toBe(true);
  expect(matchesPattern("Write", "*")).toBe(true);
  expect(matchesPattern("Write", "Write")).toBe(true);
  expect(matchesPattern("Edit", "Write|Edit")).toBe(true);
  expect(matchesPattern("Bash", "^Ba.*$")).toBe(true);
  expect(matchesPattern("Read", "^Ba.*$")).toBe(false);
  expect(matchesPattern("Read", "[")).toBe(false);
  expect(matchesPattern("aaaaaaaaaaaaaaaaaaaa", "^(a+)+$")).toBe(false);
  expect(matchesPattern("Read", "x".repeat(513))).toBe(false);
});

test("formats blocking hook messages and detects blocked outside-repl results", () => {
  const blockingError = {
    blockingError: "revise the output",
    command: "hook.sh",
  };
  expect(getStopHookMessage(blockingError)).toBe(
    "Stop hook feedback:\nrevise the output",
  );
  expect(getTeammateIdleHookMessage(blockingError)).toBe(
    "TeammateIdle hook feedback:\nrevise the output",
  );
  expect(getTaskCreatedHookMessage(blockingError)).toBe(
    "TaskCreated hook feedback:\nrevise the output",
  );
  expect(getTaskCompletedHookMessage(blockingError)).toBe(
    "TaskCompleted hook feedback:\nrevise the output",
  );

  expect(
    hasBlockingResult([
      { command: "a", succeeded: true, output: "", blocked: false },
      { command: "b", succeeded: false, output: "blocked", blocked: true },
    ]),
  ).toBe(true);
  expect(
    hasBlockingResult([
      { command: "a", succeeded: true, output: "", blocked: false },
    ]),
  ).toBe(false);
});

test("matches registered hooks with filtering, deduplication, and plugin source context", async () => {
  await configureHookSession();
  registerHookCallbacks({
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: "echo one" },
          { type: "command", command: "echo one" },
          { type: "command", command: "echo one", shell: "powershell" },
          { type: "prompt", prompt: "review the command" },
          { type: "agent", prompt: "inspect the command" },
          { type: "http", url: "https://example.test/hook" },
          { type: "callback", callback: async () => ({}) },
        ],
      },
      {
        matcher: "Read",
        hooks: [{ type: "command", command: "echo ignored" }],
      },
      {
        matcher: "Bash",
        pluginRoot: "/plugins/a",
        pluginId: "plugin-a",
        pluginName: "Plugin A",
        hooks: [{ type: "command", command: "echo one" }],
      },
    ],
  } as never);

  const matched = await getMatchingHooks(undefined, sessionId, "PreToolUse", {
    ...createBaseHookInput(),
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git status" },
    tool_id: "tool-1",
  } as never);

  expect(matched).toHaveLength(7);
  expect(matched.map((match) => match.hook.type).sort()).toEqual([
    "agent",
    "callback",
    "command",
    "command",
    "command",
    "http",
    "prompt",
  ]);
  expect(matched.some((match) => match.hookSource === "plugin:Plugin A")).toBe(
    true,
  );
  expect(matched.some((match) => match.pluginId === "plugin-a")).toBe(true);
  expect(
    matched.filter(
      (match) =>
        match.hook.type === "command" && match.hook.command === "echo one",
    ),
  ).toHaveLength(3);
  expect(
    matched
      .filter((match) => match.hook.type === "command")
      .map((match) => ({
        command: match.hook.command,
        shell: match.hook.shell,
        pluginRoot: match.pluginRoot,
      })),
  ).toEqual([
    { command: "echo one", shell: undefined, pluginRoot: undefined },
    { command: "echo one", shell: "powershell", pluginRoot: undefined },
    { command: "echo one", shell: undefined, pluginRoot: "/plugins/a" },
  ]);
});

test("filters HTTP hooks from startup events during matching", async () => {
  await configureHookSession();
  registerHookCallbacks({
    SessionStart: [
      {
        matcher: "startup",
        hooks: [
          { type: "command", command: "echo startup" },
          { type: "http", url: "https://example.test/startup" },
        ],
      },
    ],
  } as never);

  const matched = await getMatchingHooks(undefined, sessionId, "SessionStart", {
    ...createBaseHookInput(),
    hook_event_name: "SessionStart",
    source: "startup",
  } as never);
  expect(matched).toEqual([
    expect.objectContaining({
      hook: { type: "command", command: "echo startup" },
      hookSource: "settings",
    }),
  ]);
});

test("executes registered callback hooks through the permission generator", async () => {
  await configureHookSession();
  acceptInteractiveWorkspaceTrust();
  const appState = { sessionHooks: new Map<string, unknown>() };
  registerHookCallbacks({
    PermissionRequest: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "callback",
            callback: async () => ({
              decision: "block",
              reason: "callback blocked command",
            }),
          },
        ],
      },
    ],
  } as never);

  const results = await collectAsyncGenerator(
    executePermissionRequestHooks(
      "Bash",
      "tool-1",
      { command: "rm -rf /tmp/nope" },
      toolUseContext(appState),
      "default",
      [],
      undefined,
      hookCommandTimeoutMs,
    ),
  );

  expect(results.some((result) => result.message?.type === "progress")).toBe(
    true,
  );
  expect(
    results.some(
      (result) =>
        result.blockingError?.blockingError === "callback blocked command" &&
        result.blockingError.command === "callback",
    ),
  ).toBe(true);
  expect(
    results.some(
      (result) =>
        result.permissionBehavior === "deny" &&
        result.hookPermissionDecisionReason === "callback blocked command",
    ),
  ).toBe(true);
});

test("executes command hooks through the permission generator", async () => {
  await configureHookSession();
  acceptInteractiveWorkspaceTrust();
  const appState = { sessionHooks: new Map<string, unknown>() };
  registerHookCallbacks({
    PermissionRequest: [
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: stdoutCommand("plain hook ok\n") },
          {
            type: "command",
            command: stdoutCommand(
              JSON.stringify({
                decision: "approve",
                reason: "approved by command",
                systemMessage: "command system message",
                hookSpecificOutput: {
                  hookEventName: "PermissionRequest",
                  decision: {
                    behavior: "allow",
                    updatedInput: { command: "pwd" },
                    updatedPermissions: [],
                  },
                },
              }),
            ),
          },
        ],
      },
    ],
  } as never);

  const results = await collectAsyncGenerator(
    executePermissionRequestHooks(
      "Bash",
      "tool-command",
      { command: "ls" },
      toolUseContext(appState),
      "default",
      [],
      undefined,
      hookCommandTimeoutMs,
    ),
  );

  expect(
    results.some((result) =>
      JSON.stringify(result.message).includes("plain hook ok"),
    ),
  ).toBe(true);
  expect(
    results.some((result) =>
      JSON.stringify(result.message).includes("command system message"),
    ),
  ).toBe(true);
  expect(
    results.some(
      (result) =>
        result.permissionBehavior === "allow" &&
        result.updatedInput?.command === "pwd",
    ),
  ).toBe(true);
});

test("untrusted automation runs callbacks and commands but blocks other hook effects", async () => {
  await configureHookSession({
    trusted: false,
    allowUntrustedCommands: true,
  });
  const callback = vi.fn(async () => ({}));
  let httpRequests = 0;
  const server = createServer((_request, response) => {
    httpRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }
    registerHookCallbacks({
      PermissionRequest: [
        {
          matcher: "Bash",
          hooks: [
            { type: "callback", callback },
            { type: "command", command: stdoutCommand("command allowed\n") },
            { type: "http", url: `http://127.0.0.1:${address.port}/hook` },
            { type: "prompt", prompt: "must not run" },
            { type: "agent", prompt: "must not run" },
          ],
        },
      ],
    } as never);

    const results = await collectAsyncGenerator(
      executePermissionRequestHooks(
        "Bash",
        "tool-untrusted-automation",
        { command: "pwd" },
        toolUseContext({ sessionHooks: new Map<string, unknown>() }),
        "default",
        [],
        undefined,
        hookCommandTimeoutMs,
      ),
    );

    expect(callback).toHaveBeenCalledTimes(1);
    expect(
      results.some((result) =>
        JSON.stringify(result.message).includes("command allowed"),
      ),
    ).toBe(true);
    expect(
      results.filter(
        (result) => result.message?.type === "progress",
      ),
    ).toHaveLength(2);
    expect(httpRequests).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("concurrent sessions apply their own authority to generic command execution", async () => {
  await configureHookSession();
  const baseSession = getCurrentRuntimeSession();
  if (baseSession === null) throw new Error("Expected a configured hook session");
  registerHookCallbacks({
    PermissionRequest: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: stdoutCommand("session command allowed\n"),
          },
        ],
      },
    ],
  } as never);

  const sessionWithAuthority = (allowUntrustedHooks: boolean) => {
    const runtimeOptions = resolveAgentRuntimeOptions({}, {
      allowUntrustedHooks,
    });
    return {
      ...baseSession,
      conversationId: `${sessionId}-${allowUntrustedHooks ? "allowed" : "denied"}`,
      services: {
        ...baseSession.services,
        runtimeOptions,
        hookExecutionAuthority: createHookExecutionAuthority({
          runtimeOptions,
          isWorkspaceTrusted: () => false,
        }),
      },
    } as never;
  };
  const execute = () =>
    collectAsyncGenerator(
      executePermissionRequestHooks(
        "Bash",
        "tool-concurrent-authority",
        { command: "pwd" },
        toolUseContext({ sessionHooks: new Map<string, unknown>() }),
        "default",
        [],
        undefined,
        hookCommandTimeoutMs,
      ),
    );

  const [allowed, denied] = await Promise.all([
    runWithCurrentRuntimeSession(sessionWithAuthority(true), execute),
    runWithCurrentRuntimeSession(sessionWithAuthority(false), execute),
  ]);

  expect(
    allowed.some((result) =>
      JSON.stringify(result.message).includes("session command allowed"),
    ),
  ).toBe(true);
  expect(denied).toEqual([]);
});

test("registered command hooks stop on the admitted lease signal", async () => {
  const { agencHome, cwd } = await configureHookSession();
  acceptInteractiveWorkspaceTrust();
  const leaseAbort = new AbortController();
  const markDispatched = vi.fn();
  const reconcile = vi.fn();
  const holdUnknown = vi.fn();
  const acknowledgeCompletion = vi.fn();
  const acquire = vi.fn(async () => ({
    decision: "allow" as const,
    reservation: {
      reservationId: "legacy-hook-reservation",
      step: { runId: "run-legacy", stepId: "hook-step" },
      reservedCostUsd: 0,
      reservedTokens: 0,
      reservedAt: new Date().toISOString(),
    },
    request: {},
    signal: leaseAbort.signal,
  }));
  const runtimeOptions = resolveAgentRuntimeOptions({});
  clearCurrentRuntimeSession();
  setCurrentRuntimeSession({
    conversationId: sessionId,
    sessionConfiguration: { cwd },
    services: {
      sandboxExecutionBroker: explicitDangerBroker,
      admissionRequired: true,
      configStore: new ConfigStore({
        home: agencHome,
        env: { AGENC_HOME: agencHome },
        cwd,
      }),
      providerService: createHookProviderService(),
      runtimeOptions,
      userShell: {
        path: "/bin/sh",
        commandWrapperArgv: [],
        childEnvironment: { ...process.env },
        deriveExecArgs: (input: string) => ["-c", input],
      },
      hookExecutionAuthority: createHookExecutionAuthority({
        runtimeOptions,
        isWorkspaceTrusted: () => true,
      }),
      executionAdmission: {
        scope: {
          runId: "run-legacy",
          workspaceId: cwd,
          sessionId,
          autonomous: false,
        },
        acquire,
        markDispatched,
        reconcile,
        holdUnknown,
        acknowledgeCompletion,
        void: vi.fn(),
        recordFallback: vi.fn(),
        forSession: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
    },
  } as never);
  const appState = { sessionHooks: new Map<string, unknown>() };
  registerHookCallbacks({
    PermissionRequest: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: nodeCommand("setInterval(() => {}, 1000)"),
          },
        ],
      },
    ],
  } as never);

  const running = collectAsyncGenerator(
    executePermissionRequestHooks(
      "Bash",
      "tool-cancelled-hook",
      { command: "pwd" },
      toolUseContext(appState),
      "default",
      [],
      undefined,
      10_000,
    ),
  );
  await vi.waitFor(() => expect(markDispatched).toHaveBeenCalledOnce());
  leaseAbort.abort(new Error("kernel deadline expired"));
  const results = await running;

  expect(
    results.some((result) =>
      JSON.stringify(result.message).includes("hook_cancelled"),
    ),
  ).toBe(true);
  expect(acquire.mock.calls[0]?.[0]).toMatchObject({ maxCostUsd: 0 });
  expect(holdUnknown).toHaveBeenCalledWith(
    "legacy-hook-reservation",
    "hook_cancelled_after_dispatch",
  );
  expect(reconcile).not.toHaveBeenCalled();
  expect(acknowledgeCompletion).toHaveBeenCalledWith("legacy-hook-reservation");
});

test("executes blocking command hook output through the permission generator", async () => {
  await configureHookSession();
  acceptInteractiveWorkspaceTrust();
  const appState = { sessionHooks: new Map<string, unknown>() };
  registerHookCallbacks({
    PermissionRequest: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: stdoutCommand(
              JSON.stringify({
                decision: "block",
                reason: "blocked by command",
              }),
            ),
          },
        ],
      },
    ],
  } as never);

  const results = await collectAsyncGenerator(
    executePermissionRequestHooks(
      "Bash",
      "tool-command-block",
      { command: "ls" },
      toolUseContext(appState),
      "default",
      [],
      undefined,
      hookCommandTimeoutMs,
    ),
  );

  expect(
    results.some(
      (result) => result.blockingError?.blockingError === "blocked by command",
    ),
  ).toBe(true);
});

test("executes outside-REPL wrapper hooks with structured outputs", async () => {
  await configureHookSession();
  acceptInteractiveWorkspaceTrust();
  let notificationCalls = 0;
  let instructionsCalls = 0;
  let sessionEndCleared = false;
  registerHookCallbacks({
    ConfigChange: [
      {
        matcher: "user_settings|policy_settings",
        hooks: [
          {
            type: "command",
            command: stdoutCommand(
              JSON.stringify({ decision: "block", reason: "config blocked" }),
            ),
          },
        ],
      },
    ],
    CwdChanged: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: stdoutCommand(
              JSON.stringify({
                systemMessage: "cwd system message",
                hookSpecificOutput: {
                  hookEventName: "CwdChanged",
                  watchPaths: ["/tmp/agenc-cwd-watch"],
                },
              }),
            ),
          },
        ],
      },
    ],
    InstructionsLoaded: [
      {
        matcher: "session_start",
        hooks: [
          {
            type: "callback",
            callback: async () => {
              instructionsCalls += 1;
              return {};
            },
          },
        ],
      },
    ],
    Notification: [
      {
        matcher: "info",
        hooks: [
          {
            type: "callback",
            callback: async () => {
              notificationCalls += 1;
              return {};
            },
          },
        ],
      },
    ],
    SessionEnd: [
      {
        matcher: "quit",
        hooks: [{ type: "callback", callback: async () => ({}) }],
      },
    ],
    WorktreeRemove: [
      {
        matcher: "*",
        hooks: [{ type: "callback", callback: async () => ({}) }],
      },
    ],
    Elicitation: [
      {
        matcher: "mcp-server",
        hooks: [
          {
            type: "command",
            command: stdoutCommand(
              JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: "Elicitation",
                  action: "accept",
                  content: { accepted: true },
                },
              }),
            ),
          },
          {
            type: "command",
            command: nodeCommand(
              "process.stderr.write('elicitation blocked'); process.exit(2)",
            ),
          },
        ],
      },
    ],
    ElicitationResult: [
      {
        matcher: "mcp-server",
        hooks: [
          {
            type: "command",
            command: stdoutCommand(
              JSON.stringify({
                reason: "result declined",
                hookSpecificOutput: {
                  hookEventName: "ElicitationResult",
                  action: "decline",
                  content: { declined: true },
                },
              }),
            ),
          },
        ],
      },
    ],
  } as never);

  const userConfig = await executeConfigChangeHooks(
    "user_settings",
    "/tmp/user.json",
    hookCommandTimeoutMs,
  );
  expect(hasBlockingResult(userConfig)).toBe(true);
  const policyConfig = await executeConfigChangeHooks(
    "policy_settings",
    "/tmp/policy.json",
    hookCommandTimeoutMs,
  );
  expect(hasBlockingResult(policyConfig)).toBe(false);

  await expect(
    executeCwdChangedHooks("/old", "/new", hookCommandTimeoutMs),
  ).resolves.toMatchObject({
    watchPaths: ["/tmp/agenc-cwd-watch"],
    systemMessages: ["cwd system message"],
  });
  await executeInstructionsLoadedHooks(
    "/tmp/AGENC.md",
    "Project",
    "session_start",
    {
      timeoutMs: hookCommandTimeoutMs,
    },
  );
  await executeNotificationHooks(
    { message: "hello", notificationType: "info", title: "Info" },
    hookCommandTimeoutMs,
  );
  expect(instructionsCalls).toBe(1);
  expect(notificationCalls).toBe(1);

  await executeSessionEndHooks("quit" as never, {
    timeoutMs: hookCommandTimeoutMs,
    setAppState: (updater) => {
      sessionEndCleared = true;
      updater({ sessionHooks: new Map<string, unknown>() } as never);
    },
  });
  expect(sessionEndCleared).toBe(true);
  await expect(executeWorktreeRemoveHook("/tmp/worktree")).resolves.toBe(true);

  await expect(
    executeElicitationHooks({
      serverName: "mcp-server",
      message: "Need a value",
      timeoutMs: hookCommandTimeoutMs,
    }),
  ).resolves.toMatchObject({
    elicitationResponse: { action: "accept", content: { accepted: true } },
    blockingError: { blockingError: "elicitation blocked" },
  });
  await expect(
    executeElicitationResultHooks({
      serverName: "mcp-server",
      action: "accept",
      content: { value: true },
      timeoutMs: hookCommandTimeoutMs,
    }),
  ).resolves.toMatchObject({
    elicitationResultResponse: {
      action: "decline",
      content: { declined: true },
    },
    blockingError: { blockingError: "result declined" },
  });
});

test("executes session-scoped function hooks through stop hooks", async () => {
  await configureHookSession();
  acceptInteractiveWorkspaceTrust();
  const appState = {
    sessionHooks: new Map<string, unknown>([
      [
        sessionId,
        {
          hooks: {
            Stop: [
              {
                matcher: "*",
                hooks: [
                  {
                    hook: {
                      type: "function",
                      id: "fn-stop",
                      callback: () => false,
                      errorMessage: "function blocked stop",
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]),
  };
  const messages = [
    {
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000903",
      message: {
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "last response" }],
      },
    },
  ] as Message[];

  const results = await collectAsyncGenerator(
    executeStopHooks(
      "default",
      undefined,
      hookCommandTimeoutMs,
      false,
      undefined,
      toolUseContext(appState),
      messages,
    ),
  );

  expect(results.some((result) => result.message?.type === "progress")).toBe(
    true,
  );
  expect(
    results.some(
      (result) =>
        result.blockingError?.blockingError === "function blocked stop" &&
        result.blockingError.command === "function",
    ),
  ).toBe(true);
});

test("executes registered callback hooks across active event wrappers", async () => {
  await configureHookSession();
  acceptInteractiveWorkspaceTrust();
  const appState = { sessionHooks: new Map<string, unknown>() };
  const ctx = toolUseContext(appState);
  registerHookCallbacks({
    PostToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "callback",
            callback: async () => ({
              hookSpecificOutput: {
                hookEventName: "PostToolUse",
                additionalContext: "post context",
                updatedMCPToolOutput: { patched: true },
              },
            }),
          },
        ],
      },
    ],
    PostToolUseFailure: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "callback",
            callback: async () => ({
              continue: false,
              stopReason: "stop after failure",
              hookSpecificOutput: {
                hookEventName: "PostToolUseFailure",
                additionalContext: "failure context",
              },
            }),
          },
        ],
      },
    ],
    PermissionDenied: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "callback",
            callback: async () => ({
              hookSpecificOutput: {
                hookEventName: "PermissionDenied",
                retry: true,
              },
            }),
          },
        ],
      },
    ],
    PermissionRequest: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "callback",
            callback: async () => ({
              hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: {
                  behavior: "allow",
                  updatedInput: { command: "pwd" },
                  updatedPermissions: [],
                },
              },
            }),
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        matcher: "*",
        hooks: [
          {
            type: "callback",
            callback: async () => ({
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: "prompt context",
              },
            }),
          },
        ],
      },
    ],
    SessionStart: [
      {
        matcher: "resume",
        hooks: [
          {
            type: "callback",
            callback: async () => ({
              hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext: "session context",
                initialUserMessage: "start here",
                watchPaths: ["/tmp/watch-session"],
              },
            }),
          },
        ],
      },
    ],
    Setup: [
      {
        matcher: "init",
        hooks: [
          {
            type: "callback",
            callback: async () => ({
              hookSpecificOutput: {
                hookEventName: "Setup",
                additionalContext: "setup context",
              },
            }),
          },
        ],
      },
    ],
    SubagentStart: [
      {
        matcher: "runner",
        hooks: [
          {
            type: "callback",
            callback: async () => ({
              hookSpecificOutput: {
                hookEventName: "SubagentStart",
                additionalContext: "subagent context",
              },
            }),
          },
        ],
      },
    ],
    TeammateIdle: [
      {
        matcher: "*",
        hooks: [
          {
            type: "callback",
            callback: async () => ({
              decision: "block",
              reason: "teammate should continue",
            }),
          },
        ],
      },
    ],
    TaskCreated: [
      {
        matcher: "*",
        hooks: [
          {
            type: "callback",
            callback: async () => ({
              decision: "block",
              reason: "task creation blocked",
            }),
          },
        ],
      },
    ],
    TaskCompleted: [
      {
        matcher: "*",
        hooks: [
          {
            type: "callback",
            callback: async () => ({
              continue: false,
              stopReason: "task needs follow-up",
            }),
          },
        ],
      },
    ],
  } as never);

  const permission = await collectAsyncGenerator(
    executePermissionRequestHooks(
      "Bash",
      "tool-permission",
      { command: "ls" },
      ctx,
      "default",
      [],
      undefined,
      hookCommandTimeoutMs,
    ),
  );
  expect(
    permission.some(
      (result) =>
        result.permissionBehavior === "allow" &&
        result.updatedInput?.command === "pwd",
    ),
  ).toBe(true);
  expect(
    permission.some(
      (result) => result.permissionRequestResult?.behavior === "allow",
    ),
  ).toBe(true);

  const subagent = await collectAsyncGenerator(
    executeSubagentStartHooks(
      "agent-1",
      "runner",
      undefined,
      hookCommandTimeoutMs,
    ),
  );
  expect(
    subagent.some((result) =>
      result.additionalContexts?.includes("subagent context"),
    ),
  ).toBe(true);

  const idle = await collectAsyncGenerator(
    executeTeammateIdleHooks(
      "Alice",
      "team",
      "default",
      undefined,
      hookCommandTimeoutMs,
    ),
  );
  expect(
    idle.some(
      (result) =>
        result.blockingError?.blockingError === "teammate should continue",
    ),
  ).toBe(true);
  expect(idle.some((result) => result.permissionBehavior === "deny")).toBe(
    true,
  );

  const created = await collectAsyncGenerator(
    executeTaskCreatedHooks(
      "task-1",
      "Write tests",
      "Add coverage",
      "Alice",
      "team",
      "default",
      undefined,
      hookCommandTimeoutMs,
      ctx,
    ),
  );
  expect(
    created.some(
      (result) =>
        result.blockingError?.blockingError === "task creation blocked",
    ),
  ).toBe(true);
  expect(created.some((result) => result.permissionBehavior === "deny")).toBe(
    true,
  );

  const completed = await collectAsyncGenerator(
    executeTaskCompletedHooks(
      "task-1",
      "Write tests",
      "Add coverage",
      "Alice",
      "team",
      "default",
      undefined,
      hookCommandTimeoutMs,
      ctx,
    ),
  );
  expect(
    completed.some(
      (result) =>
        result.preventContinuation === true &&
        result.stopReason === "task needs follow-up",
    ),
  ).toBe(true);
});

test("executes outside-REPL WorktreeCreate hook variants", async () => {
  await configureHookSession();
  acceptInteractiveWorkspaceTrust();
  registerHookCallbacks({
    WorktreeCreate: [
      {
        matcher: "*",
        hooks: [
          { type: "prompt", prompt: "prepare worktree" },
          { type: "agent", prompt: "prepare worktree with agent" },
          {
            type: "function",
            id: "unexpected-outside-repl",
            callback: () => true,
          },
          {
            type: "callback",
            callback: async () => ({
              hookSpecificOutput: {
                hookEventName: "WorktreeCreate",
                worktreePath: "/tmp/agenc-worktree-callback",
              },
            }),
          },
        ],
      },
    ],
  } as never);

  expect(hasWorktreeCreateHook()).toBe(true);
  await expect(executeWorktreeCreateHook("feature")).resolves.toEqual({
    worktreePath: "/tmp/agenc-worktree-callback",
  });
});

test("executes HTTP WorktreeCreate hook JSON output", async () => {
  await configureHookSession();
  acceptInteractiveWorkspaceTrust();

  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/empty") {
      response.end("");
    } else if (request.url === "/text") {
      response.end("not json");
    } else if (request.url === "/broken") {
      response.end("{");
    } else {
      response.end(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "WorktreeCreate",
            worktreePath: "/tmp/agenc-worktree-http",
          },
        }),
      );
    }
  });

  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }

    registerHookCallbacks({
      WorktreeCreate: [
        {
          matcher: "*",
          hooks: [
            { type: "http", url: `http://127.0.0.1:${address.port}/empty` },
            { type: "http", url: `http://127.0.0.1:${address.port}/text` },
            { type: "http", url: `http://127.0.0.1:${address.port}/broken` },
            { type: "http", url: `http://127.0.0.1:${address.port}/hook` },
          ],
        },
      ],
    } as never);

    await expect(executeWorktreeCreateHook("feature")).resolves.toEqual({
      worktreePath: "/tmp/agenc-worktree-http",
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("reports malformed command hook JSON outside the REPL", async () => {
  await configureHookSession();
  acceptInteractiveWorkspaceTrust();
  registerHookCallbacks({
    WorktreeCreate: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: stdoutCommand('{"continue":"nope"}'),
          },
        ],
      },
    ],
  } as never);

  await expect(executeWorktreeCreateHook("feature")).rejects.toThrow(
    "Hook JSON output validation failed",
  );
});

test("returns empty results for public no-hook execution paths", async () => {
  await configureHookSession();

  await expect(
    executeConfigChangeHooks("user_settings", "/tmp/config.toml", 1),
  ).resolves.toEqual([]);
  await expect(
    executeConfigChangeHooks("policy_settings", "/tmp/managed-config.toml", 1),
  ).resolves.toEqual([]);
  await expect(executeCwdChangedHooks("/old", "/new", 1)).resolves.toEqual({
    results: [],
    watchPaths: [],
    systemMessages: [],
  });
  expect(hasInstructionsLoadedHook()).toBe(false);
  await expect(
    executeInstructionsLoadedHooks(
      "/tmp/AGENC.md",
      "Project",
      "session_start",
      {
        timeoutMs: 1,
      },
    ),
  ).resolves.toBeUndefined();
  await expect(
    executeElicitationHooks({
      serverName: "mcp-server",
      message: "Need a value",
      timeoutMs: 1,
    }),
  ).resolves.toEqual({});
  await expect(
    executeElicitationResultHooks({
      serverName: "mcp-server",
      action: "accept",
      content: { value: true },
      timeoutMs: 1,
    }),
  ).resolves.toEqual({});
  await expect(
    executeStatusLineCommand({} as never, undefined, 1),
  ).resolves.toBeUndefined();
  await expect(
    executeFileSuggestionCommand({} as never, undefined, 1),
  ).resolves.toEqual([]);
  expect(hasWorktreeCreateHook()).toBe(false);
  await expect(executeWorktreeRemoveHook("/tmp/worktree")).resolves.toBe(false);
  await expect(executeWorktreeCreateHook("feature")).rejects.toThrow(
    "WorktreeCreate hook failed: no successful output",
  );
});

test("simple-mode ownership hard-suppresses callback and command hook surfaces", async () => {
  await configureHookSession();
  acceptInteractiveWorkspaceTrust();
  bindHookSessionSimpleMode(true);

  const permissionCallback = vi.fn(async () => ({
    decision: "block" as const,
    reason: "must never run in simple mode",
  }));
  const notificationCallback = vi.fn(async () => ({}));
  const instructionsCallback = vi.fn(async () => ({}));
  const worktreeCreateCallback = vi.fn(async () => ({
    hookSpecificOutput: {
      hookEventName: "WorktreeCreate" as const,
      worktreePath: "/tmp/should-not-be-created",
    },
  }));
  const worktreeRemoveCallback = vi.fn(async () => ({}));
  registerHookCallbacks({
    PermissionRequest: [
      {
        matcher: "Bash",
        hooks: [{ type: "callback", callback: permissionCallback }],
      },
    ],
    Notification: [
      {
        matcher: "turn_complete",
        hooks: [{ type: "callback", callback: notificationCallback }],
      },
    ],
    InstructionsLoaded: [
      {
        matcher: "session_start",
        hooks: [{ type: "callback", callback: instructionsCallback }],
      },
    ],
    WorktreeCreate: [
      {
        matcher: "*",
        hooks: [{ type: "callback", callback: worktreeCreateCallback }],
      },
    ],
    WorktreeRemove: [
      {
        matcher: "*",
        hooks: [{ type: "callback", callback: worktreeRemoveCallback }],
      },
    ],
  } as never);

  const permissionResults = await collectAsyncGenerator(
    executePermissionRequestHooks(
      "Bash",
      "tool-simple-mode",
      { command: "pwd" },
      toolUseContext({ sessionHooks: new Map<string, unknown>() }),
      "default",
      [],
      undefined,
      hookCommandTimeoutMs,
    ),
  );
  await executeNotificationHooks(
    {
      message: "done",
      notificationType: "turn_complete",
    },
    hookCommandTimeoutMs,
  );

  expect(permissionResults).toEqual([]);
  expect(permissionCallback).not.toHaveBeenCalled();
  expect(notificationCallback).not.toHaveBeenCalled();
  expect(hasInstructionsLoadedHook()).toBe(false);
  expect(instructionsCallback).not.toHaveBeenCalled();
  expect(hasWorktreeCreateHook()).toBe(false);
  await expect(executeWorktreeRemoveHook("/tmp/worktree")).resolves.toBe(
    false,
  );
  expect(worktreeCreateCallback).not.toHaveBeenCalled();
  expect(worktreeRemoveCallback).not.toHaveBeenCalled();

  const session = getCurrentRuntimeSession();
  if (session === null) throw new Error("Expected a configured hook session");
  const configStore = session.services.configStore;
  if (configStore === undefined) {
    throw new Error("Expected a canonical ConfigStore");
  }
  const commandConfig = Object.freeze({
    statusLine: {
      type: "command" as const,
      command: stdoutCommand("status-hook-ran"),
    },
    fileSuggestion: {
      type: "command" as const,
      command: stdoutCommand("/tmp/first.ts\n/tmp/second.ts"),
    },
  });
  const commandAuthority = {
    authoritySnapshot: () => ({ config: commandConfig, layers: [] }),
    current: () => commandConfig,
    sources: () => [],
    projectRoot: configStore.projectRoot,
    homeContext: configStore.homeContext,
    stateRepository: configStore.stateRepository,
    reload: async () => commandConfig,
    subscribe: () => () => undefined,
  } as never;

  await runWithCanonicalSettingsAuthority(commandAuthority, async () => {
    await expect(
      executeStatusLineCommand({} as never, undefined, hookCommandTimeoutMs),
    ).resolves.toBeUndefined();
    await expect(
      executeFileSuggestionCommand(
        {} as never,
        undefined,
        hookCommandTimeoutMs,
      ),
    ).resolves.toEqual([]);

    bindHookSessionSimpleMode(false);
    await expect(
      executeStatusLineCommand({} as never, undefined, hookCommandTimeoutMs),
    ).resolves.toBe("status-hook-ran");
    await expect(
      executeFileSuggestionCommand(
        {} as never,
        undefined,
        hookCommandTimeoutMs,
      ),
    ).resolves.toEqual(["/tmp/first.ts", "/tmp/second.ts"]);
  });
});
