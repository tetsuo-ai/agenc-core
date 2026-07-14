import { afterEach, expect, test } from "vitest";
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
  executeFileChangedHooks,
  executeFileSuggestionCommand,
  executeInstructionsLoadedHooks,
  executePermissionDeniedHooks,
  executePermissionRequestHooks,
  executeNotificationHooks,
  executePostCompactHooks,
  executePostToolHooks,
  executePostToolUseFailureHooks,
  executePreCompactHooks,
  executePreToolHooks,
  executeSessionEndHooks,
  executeSessionStartHooks,
  executeSetupHooks,
  executeStatusLineCommand,
  executeStopHooks,
  executeSubagentStartHooks,
  executeTaskCompletedHooks,
  executeTaskCreatedHooks,
  executeTeammateIdleHooks,
  executeUserPromptSubmitHooks,
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  getPreToolHookBlockingMessage,
  getSessionEndHookTimeoutMs,
  getStopHookMessage,
  getTaskCompletedHookMessage,
  getTaskCreatedHookMessage,
  getTeammateIdleHookMessage,
  getUserPromptSubmitHookBlockingMessage,
  getMatchingHooks,
  hasBlockingResult,
  hasInstructionsLoadedHook,
  hasWorktreeCreateHook,
  matchesPattern,
} from "../../src/utils/hooks.js";
import type { Message } from "../../src/types/message.js";

const tempDirs: string[] = [];
const sessionId = "00000000-0000-4000-8000-000000000901";
const originalConfigDir = process.env.AGENC_CONFIG_DIR;
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

async function configureHookSession(): Promise<{ configDir: string; cwd: string }> {
  const configDir = await mkdtemp(join(tmpdir(), "agenc-hooks-core-"));
  tempDirs.push(configDir);
  process.env.AGENC_CONFIG_DIR = configDir;
  delete process.env.AGENC_HOME;
  resetStateForTests();

  const cwd = join(configDir, "workspace");
  await mkdir(cwd, { recursive: true });
  setOriginalCwd(cwd);
  setCwdState(cwd);
  switchSession(sessionId as never, null);
  return { configDir, cwd };
}

async function collectAsyncGenerator<T>(generator: AsyncGenerator<T>): Promise<T[]> {
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

afterEach(async () => {
  resetStateForTests();
  restoreOptionalEnv("AGENC_CONFIG_DIR", originalConfigDir);
  restoreOptionalEnv("AGENC_HOME", originalAgenCHome);
  restoreOptionalEnv("AGENC_SESSIONEND_HOOKS_TIMEOUT_MS", originalSessionEndTimeout);
  restoreOptionalEnv("AGENC_ALLOW_UNTRUSTED_HOOKS", originalAllowUntrustedHooks);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
  const { configDir, cwd } = await configureHookSession();
  setMainThreadAgentType("planner");

  const base = createBaseHookInput("acceptEdits");
  expect(base).toMatchObject({
    session_id: sessionId,
    cwd,
    permission_mode: "acceptEdits",
    agent_type: "planner",
  });
  expect(base.transcript_path).toContain(configDir);
  expect(base.transcript_path.endsWith(`${sessionId}.jsonl`)).toBe(true);

  const other = createBaseHookInput(undefined, "00000000-0000-4000-8000-000000000902", {
    agentId: "agent-1",
    agentType: "worker",
  });
  expect(other).toMatchObject({
    session_id: "00000000-0000-4000-8000-000000000902",
    agent_id: "agent-1",
    agent_type: "worker",
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
  const blockingError = { blockingError: "revise the output", command: "hook.sh" };
  expect(getPreToolHookBlockingMessage("PreToolUse", blockingError)).toBe(
    "PreToolUse hook error: revise the output",
  );
  expect(getStopHookMessage(blockingError)).toBe("Stop hook feedback:\nrevise the output");
  expect(getTeammateIdleHookMessage(blockingError)).toBe(
    "TeammateIdle hook feedback:\nrevise the output",
  );
  expect(getTaskCreatedHookMessage(blockingError)).toBe(
    "TaskCreated hook feedback:\nrevise the output",
  );
  expect(getTaskCompletedHookMessage(blockingError)).toBe(
    "TaskCompleted hook feedback:\nrevise the output",
  );
  expect(getUserPromptSubmitHookBlockingMessage(blockingError)).toBe(
    "UserPromptSubmit operation blocked by hook:\nrevise the output",
  );

  expect(
    hasBlockingResult([
      { command: "a", succeeded: true, output: "", blocked: false },
      { command: "b", succeeded: false, output: "blocked", blocked: true },
    ]),
  ).toBe(true);
  expect(hasBlockingResult([{ command: "a", succeeded: true, output: "", blocked: false }])).toBe(false);
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

  const matched = await getMatchingHooks(
    undefined,
    sessionId,
    "PreToolUse",
    {
      ...createBaseHookInput(),
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" },
      tool_id: "tool-1",
    } as never,
  );

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
  expect(matched.some((match) => match.hookSource === "plugin:Plugin A")).toBe(true);
  expect(matched.some((match) => match.pluginId === "plugin-a")).toBe(true);
  expect(
    matched.filter(
      (match) => match.hook.type === "command" && match.hook.command === "echo one",
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

  const matched = await getMatchingHooks(
    undefined,
    sessionId,
    "SessionStart",
    {
      ...createBaseHookInput(),
      hook_event_name: "SessionStart",
      source: "startup",
    } as never,
  );
  expect(matched).toEqual([
    expect.objectContaining({
      hook: { type: "command", command: "echo startup" },
      hookSource: "settings",
    }),
  ]);
});

test("executes registered callback hooks through the pre-tool generator", async () => {
  await configureHookSession();
  acceptInteractiveWorkspaceTrust();
  const appState = { sessionHooks: new Map<string, unknown>() };
  registerHookCallbacks({
    PreToolUse: [
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
    executePreToolHooks(
      "Bash",
      "tool-1",
      { command: "rm -rf /tmp/nope" },
      toolUseContext(appState),
      "default",
      undefined,
      hookCommandTimeoutMs,
    ),
  );

  expect(results.some((result) => result.message?.type === "progress")).toBe(true);
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

test("executes command hooks through the pre-tool generator", async () => {
  await configureHookSession();
  acceptInteractiveWorkspaceTrust();
  const appState = { sessionHooks: new Map<string, unknown>() };
  registerHookCallbacks({
    PreToolUse: [
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
                  hookEventName: "PreToolUse",
                  permissionDecision: "ask",
                  permissionDecisionReason: "ask after command",
                  updatedInput: { command: "pwd" },
                  additionalContext: "command context",
                },
              }),
            ),
          },
        ],
      },
    ],
  } as never);

  const results = await collectAsyncGenerator(
    executePreToolHooks(
      "Bash",
      "tool-command",
      { command: "ls" },
      toolUseContext(appState),
      "default",
      undefined,
      hookCommandTimeoutMs,
    ),
  );

  expect(
    results.some((result) => JSON.stringify(result.message).includes("plain hook ok")),
  ).toBe(true);
  expect(
    results.some((result) => JSON.stringify(result.message).includes("command system message")),
  ).toBe(true);
  expect(
    results.some((result) => result.additionalContexts?.includes("command context")),
  ).toBe(true);
  expect(
    results.some(
      (result) =>
        result.permissionBehavior === "ask" &&
        result.hookPermissionDecisionReason === "ask after command" &&
      result.updatedInput?.command === "pwd",
    ),
  ).toBe(true);
});

test("executes blocking command hook output through the pre-tool generator", async () => {
  await configureHookSession();
  acceptInteractiveWorkspaceTrust();
  const appState = { sessionHooks: new Map<string, unknown>() };
  registerHookCallbacks({
    PreToolUse: [
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
    executePreToolHooks(
      "Bash",
      "tool-command-block",
      { command: "ls" },
      toolUseContext(appState),
      "default",
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
    FileChanged: [
      {
        matcher: "file.txt",
        hooks: [
          {
            type: "command",
            command: stdoutCommand(
              JSON.stringify({
                systemMessage: "file system message",
                hookSpecificOutput: {
                  hookEventName: "FileChanged",
                  watchPaths: ["/tmp/agenc-file-watch"],
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
    PreCompact: [
      {
        matcher: "manual",
        hooks: [{ type: "command", command: stdoutCommand("new instructions") }],
      },
    ],
    PostCompact: [
      {
        matcher: "manual",
        hooks: [{ type: "command", command: stdoutCommand("compact noted") }],
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

  const userConfig = await executeConfigChangeHooks("user_settings", "/tmp/user.json", hookCommandTimeoutMs);
  expect(hasBlockingResult(userConfig)).toBe(true);
  const policyConfig = await executeConfigChangeHooks("policy_settings", "/tmp/policy.json", hookCommandTimeoutMs);
  expect(hasBlockingResult(policyConfig)).toBe(false);

  await expect(executeCwdChangedHooks("/old", "/new", hookCommandTimeoutMs)).resolves.toMatchObject({
    watchPaths: ["/tmp/agenc-cwd-watch"],
    systemMessages: ["cwd system message"],
  });
  await expect(executeFileChangedHooks("/tmp/file.txt", "change", hookCommandTimeoutMs)).resolves.toMatchObject({
    watchPaths: ["/tmp/agenc-file-watch"],
    systemMessages: ["file system message"],
  });

  await executeInstructionsLoadedHooks("/tmp/AGENC.md", "Project", "session_start", {
    timeoutMs: hookCommandTimeoutMs,
  });
  await executeNotificationHooks(
    { message: "hello", notificationType: "info", title: "Info" },
    hookCommandTimeoutMs,
  );
  expect(instructionsCalls).toBe(1);
  expect(notificationCalls).toBe(1);

  await expect(
    executePreCompactHooks(
      { trigger: "manual", customInstructions: "old" },
      undefined,
      hookCommandTimeoutMs,
    ),
  ).resolves.toMatchObject({
    newCustomInstructions: "new instructions",
  });
  await expect(
    executePostCompactHooks(
      { trigger: "manual", compactSummary: "summary" },
      undefined,
      hookCommandTimeoutMs,
    ),
  ).resolves.toMatchObject({
    userDisplayMessage: expect.stringContaining("compact noted"),
  });

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
    elicitationResultResponse: { action: "decline", content: { declined: true } },
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

  expect(results.some((result) => result.message?.type === "progress")).toBe(true);
  expect(
    results.some(
      (result) =>
        result.blockingError?.blockingError === "function blocked stop" &&
        result.blockingError.command === "function",
    ),
  ).toBe(true);
});

test("executes callback hooks across public generator event wrappers", async () => {
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
        matcher: "worker",
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

  const post = await collectAsyncGenerator(
    executePostToolHooks(
      "Bash",
      "tool-post",
      { command: "pwd" },
      { stdout: "/tmp" },
      ctx,
      "default",
      undefined,
      hookCommandTimeoutMs,
    ),
  );
  expect(
    post.some((result) => result.additionalContexts?.includes("post context")),
  ).toBe(true);
  expect(
    post.some(
      (result) => JSON.stringify(result.updatedMCPToolOutput) === JSON.stringify({ patched: true }),
    ),
  ).toBe(true);

  const failure = await collectAsyncGenerator(
    executePostToolUseFailureHooks(
      "Bash",
      "tool-failure",
      { command: "false" },
      "failed",
      ctx,
      false,
      "default",
      undefined,
      hookCommandTimeoutMs,
    ),
  );
  expect(
    failure.some(
      (result) =>
        result.preventContinuation === true &&
        result.stopReason === "stop after failure",
    ),
  ).toBe(true);
  expect(
    failure.some((result) => result.additionalContexts?.includes("failure context")),
  ).toBe(true);

  const denied = await collectAsyncGenerator(
    executePermissionDeniedHooks(
      "Bash",
      "tool-denied",
      { command: "false" },
      "denied",
      ctx,
      "default",
      undefined,
      hookCommandTimeoutMs,
    ),
  );
  expect(denied.some((result) => result.retry === true)).toBe(true);

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

  const prompt = await collectAsyncGenerator(
    executeUserPromptSubmitHooks("hello", "default", ctx),
  );
  expect(prompt.some((result) => result.additionalContexts?.includes("prompt context"))).toBe(true);

  const sessionStart = await collectAsyncGenerator(
    executeSessionStartHooks("resume", sessionId, "planner", "test-model", undefined, hookCommandTimeoutMs),
  );
  expect(
    sessionStart.some(
      (result) => result.additionalContexts?.includes("session context"),
    ),
  ).toBe(true);
  expect(
    sessionStart.some((result) => result.initialUserMessage === "start here"),
  ).toBe(true);
  expect(
    sessionStart.some((result) => result.watchPaths?.includes("/tmp/watch-session")),
  ).toBe(true);

  const setup = await collectAsyncGenerator(
    executeSetupHooks("init", undefined, hookCommandTimeoutMs),
  );
  expect(setup.some((result) => result.additionalContexts?.includes("setup context"))).toBe(true);

  const subagent = await collectAsyncGenerator(
    executeSubagentStartHooks("agent-1", "worker", undefined, hookCommandTimeoutMs),
  );
  expect(subagent.some((result) => result.additionalContexts?.includes("subagent context"))).toBe(true);

  const idle = await collectAsyncGenerator(
    executeTeammateIdleHooks("Alice", "team", "default", undefined, hookCommandTimeoutMs),
  );
  expect(
    idle.some(
      (result) => result.blockingError?.blockingError === "teammate should continue",
    ),
  ).toBe(true);
  expect(idle.some((result) => result.permissionBehavior === "deny")).toBe(true);

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
      (result) => result.blockingError?.blockingError === "task creation blocked",
    ),
  ).toBe(true);
  expect(created.some((result) => result.permissionBehavior === "deny")).toBe(true);

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
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
            command: stdoutCommand("{\"continue\":\"nope\"}"),
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

  await expect(executeConfigChangeHooks("user_settings", "/tmp/settings.json", 1)).resolves.toEqual([]);
  await expect(executeConfigChangeHooks("policy_settings", "/tmp/policy.json", 1)).resolves.toEqual([]);
  await expect(executeCwdChangedHooks("/old", "/new", 1)).resolves.toEqual({
    results: [],
    watchPaths: [],
    systemMessages: [],
  });
  await expect(executeFileChangedHooks("/tmp/file.txt", "change", 1)).resolves.toEqual({
    results: [],
    watchPaths: [],
    systemMessages: [],
  });
  expect(hasInstructionsLoadedHook()).toBe(false);
  await expect(
    executeInstructionsLoadedHooks("/tmp/AGENC.md", "Project", "session_start", {
      timeoutMs: 1,
    }),
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
  await expect(executeStatusLineCommand({} as never, undefined, 1)).resolves.toBeUndefined();
  await expect(executeFileSuggestionCommand({} as never, undefined, 1)).resolves.toEqual([]);
  expect(hasWorktreeCreateHook()).toBe(false);
  await expect(executeWorktreeRemoveHook("/tmp/worktree")).resolves.toBe(false);
  await expect(executeWorktreeCreateHook("feature")).rejects.toThrow(
    "WorktreeCreate hook failed: no successful output",
  );
});
