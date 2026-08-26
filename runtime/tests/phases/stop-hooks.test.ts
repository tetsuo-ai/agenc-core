import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import {
  ConfiguredHooksRuntime,
  type HookInstallTarget,
} from "../hooks/configured-hooks.js";
import { createHookExecutionAuthority } from "../hooks/execution-authority.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";
import { EventLog } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import { resolveAgentRuntimeOptions } from "../session/runtime-options.js";
import {
  evaluateStopHooks,
  executeStopFailureHooks,
  MAX_STOP_HOOK_BLOCKS,
  type StopHookHandler,
} from "./stop-hooks.js";

function mkCtx(opts: Partial<TurnContext> = {}): TurnContext {
  return {
    subId: "t1",
    realtimeActive: false,
    config: {
      model: "stub",
      cwd: "/tmp",
      features: {
      },
      multiAgentV2: {
        usageHintEnabled: false,
        usageHintText: "",
        hideSpawnAgentMetadata: false,
      },
      permissions: {
        allowLoginShell: false,
        shellEnvironmentPolicy: { allowedEnvVars: [], blockedEnvVars: [] },
        windowsSandboxPrivateDesktop: false,
      },
      ghostSnapshot: { enabled: false },
      agentRoles: [],
    },
    configSnapshot: {} as never,
    modelInfo: {
      slug: "stub",
      effectiveContextWindowPercent: 1,
      supportedReasoningLevels: [],
      defaultReasoningSummary: "auto",
      truncationPolicy: "off",
      usedFallbackModelMetadata: false,
    },
    cwd: "/tmp",
    depth: 0,
    permissionMode: "default",
    ...opts,
  } as unknown as TurnContext;
}

function mkSession(
  log: EventLog,
  stopHooks: ReadonlyArray<StopHookHandler>,
  stopFailureHooks: ReadonlyArray<StopHookHandler> = [],
  simpleMode = false,
): Session {
  let i = 0;
  return {
    conversationId: "conv-1",
    eventLog: log,
    services: {
      hooks: { stopHooks, stopFailureHooks },
      admissionRequired: false,
      runtimeOptions: resolveAgentRuntimeOptions({}, { simpleMode }),
    },
    nextInternalSubId: () => `s-${++i}`,
  } as unknown as Session;
}

function mkState(opts: Partial<TurnState> = {}): TurnState {
  return {
    messages: [],
    messagesForQuery: [],
    autoCompactTracking: undefined,
    taskBudgetRemaining: undefined,
    snipTokensFreed: 0,
    pendingMemoryPrefetch: undefined,
    pendingSkillPrefetch: undefined,
    contentReplacementState: undefined,
    assistantMessages: [],
    toolUseBlocks: [],
    needsFollowUp: false,
    toolResults: [],
    hasAttemptedReactiveCompact: false,
    maxOutputTokensOverride: undefined,
    maxOutputTokensRecoveryCount: 0,
    recoveryReentryCount: 0,
    continuationNudgeCount: 0,
    streamingToolExecutor: null,
    pendingToolUseSummary: undefined,
    pendingBudgetDecision: undefined,
    turnCount: 1,
    transition: undefined,
    stopHookActive: undefined,
    stopHookBlockingCount: 0,
    ...opts,
  };
}

describe("evaluateStopHooks", () => {
  test("no hooks configured → allowStop=true, blocking=false", async () => {
    const log = new EventLog();
    const session = mkSession(log, []);
    const result = await evaluateStopHooks(mkState(), mkCtx(), session);
    expect(result.allowStop).toBe(true);
    expect(result.blocking).toBe(false);
  });

  test("owner simple mode returns neutral before hook counters or events", async () => {
    const log = new EventLog();
    const events: unknown[] = [];
    log.subscribe((event) => events.push(event));
    let called = 0;
    const session = mkSession(
      log,
      [
        {
          name: "must-not-run",
          run: () => {
            called += 1;
            return {
              shouldStop: false,
              shouldBlock: true,
              blockReason: "must not block",
              continuationFragments: ["must not inject"],
            };
          },
        },
      ],
      [],
      true,
    );
    const state = mkState({ stopHookBlockingCount: MAX_STOP_HOOK_BLOCKS });

    await expect(evaluateStopHooks(state, mkCtx(), session)).resolves.toEqual({
      allowStop: true,
      blocking: false,
    });
    expect(called).toBe(0);
    expect(state.stopHookBlockingCount).toBe(MAX_STOP_HOOK_BLOCKS);
    expect(events).toEqual([]);
  });

  test("blocking hook injects continuation + bumps counter", async () => {
    const log = new EventLog();
    const session = mkSession(log, [
      {
        name: "lint",
        run: async () => ({
          shouldStop: false,
          shouldBlock: true,
          blockReason: "lint errors",
          continuationFragments: ["Fix the 3 ESLint errors above"],
        }),
      },
    ]);
    const state = mkState();
    const result = await evaluateStopHooks(state, mkCtx(), session);
    expect(result.blocking).toBe(true);
    expect(result.injectedMessage).toContain("Fix the 3");
    expect(state.stopHookBlockingCount).toBe(1);
  });

  test("Editor interactions never execute configured Stop hooks", async () => {
    const log = new EventLog();
    let called = 0;
    const session = mkSession(log, [
      {
        name: "unsafe-editor-stop",
        run: async () => {
          called += 1;
          return {
            shouldStop: false,
            shouldBlock: true,
            continuationFragments: ["must not run"],
          };
        },
      },
    ]);

    const result = await evaluateStopHooks(
      mkState(),
      mkCtx({
        editorInteraction: {
          interactionId: "interaction-stop-ask",
          kind: "ask",
          policy: "read_only",
          editorInstanceId: "editor-stop",
          bufferHandle: 8,
          changedtick: 2,
          contentSha256: "a".repeat(64),
          path: "/tmp/example.ts",
          range: {
            start: { line: 1, column: 0 },
            end: { line: 1, column: 1 },
          },
        },
      }),
      session,
    );

    expect(called).toBe(0);
    expect(result).toEqual({ allowStop: true, blocking: false });
  });

  test("I-17: MAX_STOP_HOOK_BLOCKS reached → force terminate + error event", async () => {
    const log = new EventLog();
    const session = mkSession(log, [
      {
        name: "always-blocks",
        run: async () => ({
          shouldStop: false,
          shouldBlock: true,
          continuationFragments: ["keep going"],
        }),
      },
    ]);
    const state = mkState({ stopHookBlockingCount: MAX_STOP_HOOK_BLOCKS });
    const errors: string[] = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string };
      if (e.msg.type === "error" && p.cause === "stop_hook_loop")
        errors.push(p.cause);
    });
    const result = await evaluateStopHooks(state, mkCtx(), session);
    expect(result.allowStop).toBe(true);
    expect(result.blocking).toBe(false);
    expect(errors).toContain("stop_hook_loop");
  });

  test("I-39: throwing hook emits typed error + continues ladder", async () => {
    const log = new EventLog();
    const session = mkSession(log, [
      {
        name: "throws",
        run: async () => {
          throw new Error("hook_boom");
        },
      },
      {
        name: "noop",
        run: async () => ({
          shouldStop: true,
          shouldBlock: false,
          continuationFragments: [],
        }),
      },
    ]);
    const errors: string[] = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string };
      if (e.msg.type === "error" && p.cause === "stop_hook_threw")
        errors.push(p.cause);
    });
    const result = await evaluateStopHooks(mkState(), mkCtx(), session);
    expect(result.allowStop).toBe(true);
    expect(errors).toContain("stop_hook_threw");
  });

  test("shouldStop: true beats shouldBlock: true when both set on one hook", async () => {
    const log = new EventLog();
    const session = mkSession(log, [
      {
        name: "stop-and-block",
        run: async () => ({
          shouldStop: true,
          stopReason: "done",
          shouldBlock: true,
          blockReason: "keep going",
          continuationFragments: ["do more work"],
        }),
      },
    ]);
    const state = mkState();
    const result = await evaluateStopHooks(state, mkCtx(), session);
    expect(result.allowStop).toBe(true);
    expect(result.blocking).toBe(false);
    expect(result.reason).toBe("done");
    expect(state.stopHookBlockingCount).toBe(0);
    expect(state.stopHookActive).toBeUndefined();
  });

  test("shouldStop from one hook beats shouldBlock from a sibling hook", async () => {
    const log = new EventLog();
    const session = mkSession(log, [
      {
        name: "blocker",
        run: async () => ({
          shouldStop: false,
          shouldBlock: true,
          blockReason: "lint errors",
          continuationFragments: ["fix lint"],
        }),
      },
      {
        name: "stopper",
        run: async () => ({
          shouldStop: true,
          stopReason: "done",
          shouldBlock: false,
          continuationFragments: [],
        }),
      },
    ]);
    const state = mkState();
    const result = await evaluateStopHooks(state, mkCtx(), session);
    expect(result.allowStop).toBe(true);
    expect(result.blocking).toBe(false);
    expect(result.reason).toBe("done");
    expect(state.stopHookBlockingCount).toBe(0);
  });

  test("empty blockReason → hook skipped, stop_hook_threw emitted, no block", async () => {
    const log = new EventLog();
    const session = mkSession(log, [
      {
        name: "no-reason",
        run: async () => ({
          shouldStop: false,
          shouldBlock: true,
          blockReason: "",
          continuationFragments: ["keep going"],
        }),
      },
    ]);
    const errors: Array<{ cause?: string; message?: string; stack?: string }> =
      [];
    log.subscribe((e) => {
      const p = e.msg.payload as {
        cause?: string;
        message?: string;
        stack?: string;
      };
      if (e.msg.type === "error" && p.cause === "stop_hook_threw")
        errors.push(p);
    });
    const state = mkState();
    const result = await evaluateStopHooks(state, mkCtx(), session);
    expect(result.allowStop).toBe(true);
    expect(result.blocking).toBe(false);
    expect(state.stopHookBlockingCount).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.stack).toBe("stop_hook_blank_reason");
    expect(errors[0]?.message).toContain("stop_hook_blank_reason");
  });

  test("whitespace-only blockReason ('   ') → hook skipped, no block", async () => {
    const log = new EventLog();
    const session = mkSession(log, [
      {
        name: "whitespace-reason",
        run: async () => ({
          shouldStop: false,
          shouldBlock: true,
          blockReason: "   ",
          continuationFragments: ["keep going"],
        }),
      },
    ]);
    const errors: Array<{ cause?: string; stack?: string }> = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string; stack?: string };
      if (e.msg.type === "error" && p.cause === "stop_hook_threw")
        errors.push(p);
    });
    const state = mkState();
    const result = await evaluateStopHooks(state, mkCtx(), session);
    expect(result.allowStop).toBe(true);
    expect(result.blocking).toBe(false);
    expect(state.stopHookBlockingCount).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.stack).toBe("stop_hook_blank_reason");
  });

  test("API-error guard: blocking hook on API-error turn → skipped", async () => {
    const log = new EventLog();
    const session = mkSession(log, [
      {
        name: "blocker",
        run: async () => ({
          shouldStop: false,
          shouldBlock: true,
          blockReason: "please continue",
          continuationFragments: ["continue"],
        }),
      },
    ]);
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a",
          role: "assistant",
          text: "Prompt is too long: ...",
          toolCalls: [],
          apiError: "context_window_exceeded",
        },
      ],
    });
    const result = await evaluateStopHooks(state, mkCtx(), session);
    expect(result.allowStop).toBe(true);
    expect(result.blocking).toBe(false);
    expect(result.reason).toBe("api_error_stop_guard");
  });

  test("configured Stop stdin uses live permission mode and turn metadata", async () => {
    const captureDir = await mkdtemp(join(tmpdir(), "agenc-stop-hook-"));
    const capturePath = join(captureDir, "stdin.json");
    const command =
      `node -e 'const fs=require("fs");let s="";` +
      `process.stdin.on("data",c=>s+=c);` +
      `process.stdin.on("end",()=>{fs.writeFileSync(${JSON.stringify(
        capturePath,
      )},s);process.stdout.write(JSON.stringify({decision:"block",reason:"captured"}));})'`;
    const runtime = new ConfiguredHooksRuntime({
      cwd: "/tmp",
      env: process.env,
      agencHome: "/tmp/agenc-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
      sandboxExecutionBroker: explicitDangerBroker,
      admissionRequired: false,
      executionAuthority: createHookExecutionAuthority({
        runtimeOptions: { simpleMode: false, allowUntrustedHooks: false },
        isWorkspaceTrusted: () => true,
      }),
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
    runtime.attachTarget(target);
    runtime.loadForTesting({
      Stop: [
        {
          hooks: [{ type: "command", command }],
        },
      ],
    });
    const log = new EventLog();
    const session = {
      conversationId: "conv-1",
      eventLog: log,
      services: {
        hooks: target,
        permissionModeRegistry: {
          current: () => ({ mode: "plan" }),
        },
      },
      rolloutStore: {
        rolloutPath: "/tmp/transcript.jsonl",
      },
      nextInternalSubId: () => "s-1",
    } as unknown as Session;

    const result = await evaluateStopHooks(
      mkState(),
      mkCtx({ permissionMode: "acceptEdits" }),
      session,
    );
    const stdin = JSON.parse(await readFile(capturePath, "utf8"));

    expect(result.blocking).toBe(true);
    expect(stdin).toMatchObject({
      hook_event_name: "Stop",
      session_id: "conv-1",
      turn_id: "t1",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/tmp",
      model: "stub",
      permission_mode: "plan",
    });
  });

  test("array-shaped live permission mode falls back to turn context", async () => {
    const capturedModes: string[] = [];
    const hook: StopHookHandler = {
      name: "capture",
      run: (request) => {
        capturedModes.push(request.permissionMode);
        return {
          shouldStop: true,
          shouldBlock: false,
          continuationFragments: [],
        };
      },
    };
    const log = new EventLog();
    const session = mkSession(log, [hook]);
    (
      session as unknown as {
        services: { permissionModeRegistry?: unknown };
      }
    ).services.permissionModeRegistry = {
      current: () =>
        Object.assign(["spoof"], {
          mode: "bypassPermissions",
        }),
    };

    const result = await evaluateStopHooks(
      mkState(),
      mkCtx({ permissionMode: "acceptEdits" }),
      session,
    );

    expect(result.allowStop).toBe(true);
    expect(capturedModes).toEqual(["acceptEdits"]);
  });
});

describe("executeStopFailureHooks", () => {
  test("no-op when last message isn't API error", async () => {
    const log = new EventLog();
    let called = 0;
    const session = mkSession(
      log,
      [],
      [
        {
          name: "failure-hook",
          run: async () => {
            called += 1;
            return {
              shouldStop: true,
              shouldBlock: false,
              continuationFragments: [],
            };
          },
        },
      ],
    );
    await executeStopFailureHooks(mkState(), mkCtx(), session);
    expect(called).toBe(0);
  });

  test("fires on API-error assistant message", async () => {
    const log = new EventLog();
    let called = 0;
    const session = mkSession(
      log,
      [],
      [
        {
          name: "failure-hook",
          run: async () => {
            called += 1;
            return {
              shouldStop: true,
              shouldBlock: false,
              continuationFragments: [],
            };
          },
        },
      ],
    );
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a",
          role: "assistant",
          text: "",
          toolCalls: [],
          apiError: "context_window_exceeded",
        },
      ],
    });
    await executeStopFailureHooks(state, mkCtx(), session);
    expect(called).toBe(1);
  });

  test("owner simple mode returns before StopFailure work", async () => {
    const log = new EventLog();
    const events: unknown[] = [];
    log.subscribe((event) => events.push(event));
    let called = 0;
    const session = mkSession(
      log,
      [],
      [
        {
          name: "must-not-run",
          run: () => {
            called += 1;
            throw new Error("must not emit");
          },
        },
      ],
      true,
    );
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a",
          role: "assistant",
          text: "",
          toolCalls: [],
          apiError: "context_window_exceeded",
        },
      ],
    });

    await executeStopFailureHooks(state, mkCtx(), session);

    expect(called).toBe(0);
    expect(events).toEqual([]);
  });

  test("Editor interactions never execute configured StopFailure hooks", async () => {
    const log = new EventLog();
    let called = 0;
    const session = mkSession(
      log,
      [],
      [
        {
          name: "unsafe-editor-stop-failure",
          run: async () => {
            called += 1;
            return {
              shouldStop: true,
              shouldBlock: false,
              continuationFragments: [],
            };
          },
        },
      ],
    );
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a",
          role: "assistant",
          text: "",
          toolCalls: [],
          apiError: "context_window_exceeded",
        },
      ],
    });

    await executeStopFailureHooks(
      state,
      mkCtx({
        editorInteraction: {
          interactionId: "interaction-stop-failure-ask",
          kind: "ask",
          policy: "read_only",
          editorInstanceId: "editor-stop-failure",
          bufferHandle: 9,
          changedtick: 2,
          contentSha256: "b".repeat(64),
          path: "/tmp/example.ts",
          range: {
            start: { line: 1, column: 0 },
            end: { line: 1, column: 1 },
          },
        },
      }),
      session,
    );

    expect(called).toBe(0);
  });
});
