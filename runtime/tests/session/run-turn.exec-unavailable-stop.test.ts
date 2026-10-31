import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import type { LLMResponse } from "../../src/llm/types.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import type { StopHookHandler, StopHookOutcome } from "../../src/phases/stop-hooks.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { STEP_LIMIT_WRAPUP_INSTRUCTION } from "../../src/session/step-limit-wrapup.js";
import type { Event } from "../../src/session/session.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { QuickJsCodeModeService } from "../../src/tools/code-mode/service.js";
import { createCodeModeTools } from "../../src/tools/code-mode/tools.js";
import type { CodeModeService, CodeModeTurnHost } from "../../src/tools/code-mode/types.js";
import { createExecCommandTool } from "../../src/tools/system/exec-command.js";
import { createListProcessesTool } from "../../src/tools/system/list-processes.js";
import type { Tool } from "../../src/tools/types.js";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import { bindExplicitDangerBoundary } from "../helpers/explicit-danger-boundary.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";

/**
 * Regression from a live session (Core 0.19.23, DeepSeek, Light, approvals
 * off): unified exec had closed after a killed command's cleanup could not be
 * proven. Every exec_command was refused before it started, with an error
 * that never said the shell was gone for the session, and the model tried
 * one shell command after another for 12 minutes (2.3M tokens) until the
 * task budget prompt. The turn must end at the first refused shell call, as
 * the bounded `exec_unavailable` stop, with the reason as its last words.
 */

let root: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

type FakePtyExit = (event: { readonly exitCode: number; readonly signal?: string }) => void;

/**
 * A real manager whose admission closed because a strict drain could not
 * prove that a terminal process exited. The terminal is a PTY stand-in with
 * pid 0, so no real process is signalled; the manager is the real one.
 */
async function closedManager(cwd: string) {
  const manager = new UnifiedExecProcessManager({ cwd, sandboxAuthorityQuiesceTimeoutMs: 20 });
  let exit: FakePtyExit | undefined;
  Object.assign(manager, {
    loadPty: async () => ({
      spawn: () => ({
        pid: 0,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        onData: () => ({ dispose: vi.fn() }),
        onExit: (listener: FakePtyExit) => {
          exit = listener;
          return { dispose: vi.fn() };
        },
      }),
    }),
  });
  await manager.execCommand({ cmd: "bash -i", tty: true, yield_time_ms: 250 });
  const token = manager.beginSandboxAuthorityQuiesce();
  await expect(manager.finishSandboxAuthorityQuiesce(token)).rejects.toThrow(/process-tree cleanup/);
  return {
    manager,
    dispose: async () => {
      exit?.({ exitCode: 137, signal: "SIGKILL" });
      await manager.closeAll("test cleanup").catch(() => {});
    },
  };
}

/** A bypass-mode session whose tool calls run through the real turn loop. */
function bypassSession(
  provider: ReturnType<typeof mkProvider>,
  registry: ToolRegistry,
  services: Record<string, unknown> = {},
) {
  const runtimeOptions = resolveAgentRuntimeOptions({}, {
    lightMode: true,
    dangerouslyBypassApprovalsAndSandbox: true,
  });
  const made = mkSession({ provider, registry, services: { runtimeOptions, ...services } });
  Object.assign(made.session.services, {
    permissionModeRegistry: new PermissionModeRegistry({
      ...made.session.permissionModeRegistry.current(),
      mode: "bypassPermissions",
      isBypassPermissionsModeAvailable: true,
    }),
  });
  const ctx = mkCtx({ permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" } });
  return { ...made, ctx };
}

function terminals(events: readonly Event[]) {
  return events.flatMap((event) => {
    const terminal = classifyTurnTerminal(event.msg, { expectedTurnId: mkCtx().subId });
    return terminal === undefined ? [] : [terminal];
  });
}

function warnings(events: readonly Event[], cause: string) {
  return events.filter(
    (event) => event.msg.type === "warning" && event.msg.payload.cause === cause,
  );
}

const USAGE = { promptTokens: 10, completionTokens: 1, totalTokens: 11 };

function toolCallResponse(id: string, name: string, args: Record<string, unknown>, content: string): LLMResponse {
  return { content, toolCalls: [{ id, name, arguments: JSON.stringify(args) }], usage: USAGE, model: "test-model", finishReason: "tool_calls" };
}

function textResponse(content: string): LLMResponse {
  return { content, toolCalls: [], usage: USAGE, model: "test-model", finishReason: "stop" };
}

/** The real exec_command over a paused manager, as the registry's only tool. */
function execCommandRegistry(manager: UnifiedExecProcessManager, cwd: string, calls: string[]): ToolRegistry {
  const execTool = bindExplicitDangerBoundary(createExecCommandTool({ unifiedExecManager: manager, cwd }));
  const shell = {
    name: "exec_command",
    description: "Run a shell command",
    inputSchema: { type: "object" },
    recoveryCategory: "side-effecting",
    execute: async (args: Record<string, unknown>) => {
      calls.push(String(args.cmd));
      return execTool.execute(args);
    },
  };
  return { tools: [shell], toLLMTools: () => [], dispatch: shell.execute } as unknown as ToolRegistry;
}

/**
 * A code-mode `exec` tool whose script, `try { await tools.list_processes() }
 * catch (error) { text("caught") }`, is played synchronously: it calls the
 * real list_processes tool over the paused manager and catches the refusal.
 */
function catchingCodeModeRegistry(manager: UnifiedExecProcessManager) {
  const listProcesses = createListProcessesTool({ unifiedExecManager: manager });
  const caught: string[] = [];
  let nestedCalls = 0;
  let host: CodeModeTurnHost | undefined;
  const service: CodeModeService = {
    enabled: () => true,
    storedValues: async () => ({}),
    replaceStoredValues: async () => {},
    allocateCellId: () => "1",
    async execute(request) {
      try {
        await host!.invokeTool({
          cellId: request.cellId,
          runtimeToolCallId: `nested-${nestedCalls}`,
          toolName: "list_processes",
          input: {},
        }, new AbortController().signal);
      } catch (error) {
        caught.push(error instanceof Error ? error.message : String(error));
      }
      return {
        type: "result",
        cellId: request.cellId,
        contentItems: [{ type: "input_text", text: "caught" }],
        storedValues: {},
        durationMs: 1,
      };
    },
    wait: async (request) => ({ type: "terminated", cellId: request.cellId, contentItems: [], durationMs: 0 }),
    startTurnWorker(next) {
      host = next;
      return { dispose: () => { if (host === next) host = undefined; } };
    },
  };
  const [codeExec] = createCodeModeTools({ service, getEnabledTools: () => [listProcesses] });
  const registry = {
    tools: [codeExec],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "", isError: false }),
    dispatchCodeModeNestedTool: async (call: { readonly input?: unknown }) => {
      nestedCalls += 1;
      return listProcesses.execute((call.input ?? {}) as Record<string, unknown>);
    },
  } as unknown as ToolRegistry;
  return { registry, service, caught, nestedCalls: () => nestedCalls };
}

const HOOK_REQUEST = "Run the checks first.";

/**
 * A Stop hook that blocks once and asks for more work, as a check-running
 * hook does. `whileRunning` runs inside that first run before the hook
 * answers, so what it waits for happens while the hook is awaited.
 */
function blockingOnceStopHook(whileRunning?: () => Promise<void>) {
  let calls = 0;
  const block: StopHookOutcome = {
    shouldStop: false,
    shouldBlock: true,
    blockReason: "checks not run",
    continuationFragments: [HOOK_REQUEST],
  };
  const handler: StopHookHandler = {
    name: "run-checks",
    run: () => {
      calls += 1;
      if (calls > 1) return { shouldStop: true, shouldBlock: false, continuationFragments: [] };
      return whileRunning === undefined ? block : whileRunning().then(() => block);
    },
  };
  return { hooks: { executeStop: async () => ({}), stopHooks: [handler] }, calls: () => calls };
}

/**
 * A background check, run by the real QuickJS service: `exec` yields at once
 * while the script waits in `hold`. `deliverRefusal()` lets it go on to the
 * real list_processes over the paused manager and resolves true once the
 * script has caught that refusal and called `finished`. The turn host records
 * the stop before the script sees the error, so it is pending by then.
 */
const HELD_SCRIPT = [
  '// @exec: {"yield_time_ms": 10}',
  "await tools.hold({});",
  'try { await tools.list_processes({}); } catch (error) { text("caught"); }',
  "await tools.finished({});",
].join("\n");

function heldScript(
  manager: UnifiedExecProcessManager,
  service: QuickJsCodeModeService,
  otherTools: readonly Tool[] = [],
) {
  const listProcesses = createListProcessesTool({ unifiedExecManager: manager });
  const step = (name: string) => ({
    name,
    description: `Test step: ${name}.`,
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ content: "{}" }),
  }) as unknown as Tool;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let markFinished!: () => void;
  const finished = new Promise<void>((resolve) => { markFinished = resolve; });
  const nested: string[] = [];
  const [codeExec] = createCodeModeTools({
    service,
    getEnabledTools: () => [step("hold"), listProcesses, step("finished")],
  });
  const tools = [codeExec!, ...otherTools];
  const registry = {
    tools,
    toLLMTools: () => [],
    dispatch: async (call: { readonly name: string; readonly arguments: string }) =>
      tools.find((tool) => tool.name === call.name)!.execute(JSON.parse(call.arguments) as Record<string, unknown>),
    dispatchCodeModeNestedTool: async (call: { readonly name: string; readonly input?: unknown }) => {
      nested.push(call.name);
      if (call.name === "hold") await released;
      if (call.name === "finished") markFinished();
      return call.name === "list_processes"
        ? listProcesses.execute((call.input ?? {}) as Record<string, unknown>)
        : { content: "{}" };
    },
  } as unknown as ToolRegistry;
  const deliverRefusal = async (): Promise<boolean> => {
    release();
    return Promise.race([finished.then(() => true), delay(10_000).then(() => false)]);
  };
  return { registry, nested, deliverRefusal };
}

async function runToEnd(
  made: ReturnType<typeof bypassSession>,
  prompt: string,
): Promise<PhaseEvent[]> {
  const phases: PhaseEvent[] = [];
  for await (const phase of runTurn(made.session, made.ctx, prompt)) phases.push(phase);
  return phases;
}

function expectExecUnavailableEnd(phases: readonly PhaseEvent[], events: readonly Event[]): void {
  expect(phases.at(-1)).toMatchObject({ stopReason: "exec_unavailable" });
  expect(terminals(events)).toEqual([
    expect.objectContaining({ outcome: "errored", failureCode: "exec_unavailable" }),
  ]);
  expect(warnings(events, "exec_unavailable")).toHaveLength(1);
}

describe("exec_unavailable ends the turn", () => {
  test("a model that keeps trying shell commands is stopped at the first refusal", async () => {
    root = mkdtempSync(join(tmpdir(), "exec-unavailable-turn-"));
    const closed = await closedManager(root);
    try {
      const shellCalls: string[] = [];
      let samples = 0;
      const provider = mkProvider();
      provider.chatStream = async (): Promise<LLMResponse> => {
        samples += 1;
        // Different every time, as the model did: the exact-repeat backstop
        // never sees an identical call.
        return samples <= 20
          ? toolCallResponse(`call-${samples}`, "exec_command", { cmd: `ls -la attempt-${samples}` }, "Let me try another command.")
          : textResponse("finished");
      };
      const made = bypassSession(provider, execCommandRegistry(closed.manager, root, shellCalls));
      const phases = await runToEnd(made, "Build the site and check it with the shell.");

      // One sample and one refused call: no second chance to loop.
      expect(samples).toBe(1);
      expect(shellCalls).toEqual(["ls -la attempt-1"]);
      const results = made.events.flatMap((event) =>
        event.msg.type === "tool_call_completed" ? [String(event.msg.payload.result)] : [],
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toContain('"code":"exec_unavailable"');
      expect(results[0]).toContain("Do not call exec_command");
      expectExecUnavailableEnd(phases, made.events);
      // The user sees why, and what to do, as the turn's last words.
      const [warning] = warnings(made.events, "exec_unavailable");
      expect(warning?.msg.payload).toMatchObject({
        message: expect.stringContaining("Shell commands are disabled for the rest of this session."),
      });
      expect(JSON.stringify(warning?.msg.payload)).toContain("Start a new session to run shell commands.");
      const lastAssistant = [...made.state.history].reverse().find((message) => message.role === "assistant");
      expect(String(lastAssistant?.content)).toContain("Shell commands are disabled for the rest of this session.");
      expect(warnings(made.events, "no_progress_detected")).toEqual([]);
    } finally {
      await closed.dispose();
    }
  });

  test("a refusal inside a code-mode script ends the turn even when the script catches it", async () => {
    root = mkdtempSync(join(tmpdir(), "exec-unavailable-code-mode-"));
    const closed = await closedManager(root);
    try {
      const codeMode = catchingCodeModeRegistry(closed.manager);
      let samples = 0;
      const provider = mkProvider();
      provider.chatStream = async (): Promise<LLMResponse> => {
        samples += 1;
        return samples <= 20
          ? toolCallResponse(`call-${samples}`, "exec", {
              code: `try { await tools.list_processes() } catch (error) { text("caught ${samples}") }`,
            }, "Let me check the processes from a script.")
          : textResponse("finished");
      };
      const made = bypassSession(provider, codeMode.registry, { codeModeService: codeMode.service });
      const phases = await runToEnd(made, "Check the processes with a script.");

      // The script caught the refusal and finished; the turn still ended.
      expect(codeMode.caught).toHaveLength(1);
      expect(codeMode.caught[0]).toContain('"code":"exec_unavailable"');
      expect(samples).toBe(1);
      expect(codeMode.nestedCalls()).toBe(1);
      expectExecUnavailableEnd(phases, made.events);
      expect(warnings(made.events, "exec_unavailable")[0]?.msg.payload).toMatchObject({
        message: expect.stringContaining("Shell commands are disabled for the rest of this session."),
      });
    } finally {
      await closed.dispose();
    }
  });

  test.each(["exec_command", "a code-mode script"] as const)(
    "a blocking Stop hook cannot send the turn back to work after %s is refused",
    async (kind) => {
      root = mkdtempSync(join(tmpdir(), "exec-unavailable-stop-hook-"));
      const closed = await closedManager(root);
      try {
        const hook = blockingOnceStopHook();
        const codeMode = kind === "exec_command" ? undefined : catchingCodeModeRegistry(closed.manager);
        let samples = 0;
        const provider = mkProvider();
        provider.chatStream = async (): Promise<LLMResponse> => {
          samples += 1;
          if (samples > 1) return textResponse("Done.");
          return codeMode === undefined
            ? toolCallResponse("call-1", "exec_command", { cmd: "ls -la" }, "Checking the build.")
            : toolCallResponse("call-1", "exec", {
                code: 'try { await tools.list_processes() } catch (error) { text("caught") }',
              }, "Checking from a script.");
        };
        const made = bypassSession(provider, codeMode?.registry ?? execCommandRegistry(closed.manager, root, []), {
          hooks: hook.hooks,
          ...(codeMode !== undefined ? { codeModeService: codeMode.service } : {}),
        });
        const phases = await runToEnd(made, "Build the site and run the checks.");

        // The hook ran once. Its request for more work neither re-entered the
        // turn nor reached the history, and the turn ended with the reason.
        expect(hook.calls()).toBe(1);
        expect(samples).toBe(1);
        expectExecUnavailableEnd(phases, made.events);
        expect(JSON.stringify(made.state.history)).not.toContain("Run the checks first.");
      } finally {
        await closed.dispose();
      }
    },
  );

  test.each([["without", false], ["with", true]] as const)(
    "a refusal that reaches a yielded code-mode script ends the turn when the next answer calls no tool (%s a blocking Stop hook)",
    async (_label, withHook) => {
      root = mkdtempSync(join(tmpdir(), "exec-unavailable-yielded-"));
      const closed = await closedManager(root);
      const service = new QuickJsCodeModeService({ enabled: true });
      try {
        expect(service.enabled()).toBe(true);
        const hook = blockingOnceStopHook();
        const listProcesses = createListProcessesTool({ unifiedExecManager: closed.manager });
        let nestedCalls = 0;
        let markRefused!: () => void;
        const refused = new Promise<void>((resolve) => { markRefused = resolve; });
        const [codeExec] = createCodeModeTools({ service, getEnabledTools: () => [listProcesses] });
        let samples = 0;
        const provider = mkProvider();
        provider.chatStream = async (): Promise<LLMResponse> => {
          samples += 1;
          if (samples === 1) {
            return toolCallResponse("call-1", "exec", {
              code: [
                '// @exec: {"yield_time_ms": 10}',
                "await new Promise((resolve) => setTimeout(resolve, 300));",
                'try { await tools.list_processes({}); } catch (error) { text("caught"); }',
              ].join("\n"),
            }, "Starting a background check.");
          }
          // The exec call yielded; the script's call is refused while this
          // answer is being written, and the answer calls no tool.
          await Promise.race([refused, delay(10_000)]);
          await delay(50);
          return textResponse("The check keeps running in the background.");
        };
        const registry = {
          tools: [codeExec],
          toLLMTools: () => [],
          dispatch: async () => ({ content: "", isError: false }),
          dispatchCodeModeNestedTool: async (call: { readonly input?: unknown }) => {
            nestedCalls += 1;
            const result = await listProcesses.execute((call.input ?? {}) as Record<string, unknown>);
            markRefused();
            return result;
          },
        } as unknown as ToolRegistry;
        const made = bypassSession(provider, registry, {
          codeModeService: service,
          ...(withHook ? { hooks: hook.hooks } : {}),
        });
        const phases = await runToEnd(made, "Start the background check.");

        expect(nestedCalls).toBe(1);
        expect(samples).toBe(2);
        const results = made.events.flatMap((event) =>
          event.msg.type === "tool_call_completed" ? [String(event.msg.payload.result)] : [],
        );
        // The exec call itself only yielded; the refusal came after it.
        expect(results).toHaveLength(1);
        expect(results[0]).toContain("status=yielded");
        expectExecUnavailableEnd(phases, made.events);
        expect(hook.calls()).toBe(withHook ? 1 : 0);
        expect(JSON.stringify(made.state.history)).not.toContain("Run the checks first.");
      } finally {
        await service.wait({ cellId: "1", terminate: true }).catch(() => {});
        await closed.dispose();
      }
    },
    20_000,
  );

  test("a refusal that lands while a blocking Stop hook is awaited ends the turn, and the hook's request stays out of the history", async () => {
    root = mkdtempSync(join(tmpdir(), "exec-unavailable-during-hook-"));
    const closed = await closedManager(root);
    const service = new QuickJsCodeModeService({ enabled: true });
    try {
      expect(service.enabled()).toBe(true);
      const held = heldScript(closed.manager, service);
      let refusedWhileAwaited = false;
      // The hook lets the held script meet its refusal and waits until the
      // script has caught it. Only then does it ask for more work.
      const hook = blockingOnceStopHook(async () => {
        refusedWhileAwaited = await held.deliverRefusal();
      });
      const requests: string[] = [];
      const provider = mkProvider();
      provider.chatStream = async (messages): Promise<LLMResponse> => {
        requests.push(JSON.stringify(messages));
        // The exec call yields with its script held, so nothing is refused
        // yet when this answer, which calls no tool, goes to commit.
        return requests.length === 1
          ? toolCallResponse("call-1", "exec", { code: HELD_SCRIPT }, "Starting a background check.")
          : textResponse("The check keeps running in the background.");
      };
      const made = bypassSession(provider, held.registry, { codeModeService: service, hooks: hook.hooks });
      const phases = await runToEnd(made, "Start the background check.");

      expect(refusedWhileAwaited).toBe(true);
      expect(held.nested).toEqual(["hold", "list_processes", "finished"]);
      expect(hook.calls()).toBe(1);
      expect(requests).toHaveLength(2);
      expectExecUnavailableEnd(phases, made.events);
      // Dropped, not written down for later prompts or a resumed session.
      expect(JSON.stringify(made.state.history)).not.toContain(HOOK_REQUEST);
    } finally {
      await service.wait({ cellId: "1", terminate: true }).catch(() => {});
      await closed.dispose();
    }
  }, 20_000);

  test("a refusal that lands while a Stop hook is awaited after another stop keeps the hook from sending the turn back to work", async () => {
    root = mkdtempSync(join(tmpdir(), "exec-unavailable-hook-after-stop-"));
    const closed = await closedManager(root);
    const service = new QuickJsCodeModeService({ enabled: true });
    try {
      expect(service.enabled()).toBe(true);
      // Stands in for the live-effect gate refusing a write whose earlier
      // effect awaits review: a bounded stop of its own (#2501).
      const reviewStop = {
        name: "write_report",
        description: "Write the report.",
        inputSchema: { type: "object" },
        recoveryCategory: "side-effecting",
        execute: async () => ({
          content: "Refused: an earlier write awaits review.",
          isError: true,
          metadata: { effectReviewStop: { explanation: "An earlier write awaits review, so this turn stops now." } },
        }),
      } as unknown as Tool;
      const held = heldScript(closed.manager, service, [reviewStop]);
      let refusedWhileAwaited = false;
      const hook = blockingOnceStopHook(async () => {
        refusedWhileAwaited = await held.deliverRefusal();
      });
      const requests: string[] = [];
      const provider = mkProvider();
      provider.chatStream = async (messages): Promise<LLMResponse> => {
        requests.push(JSON.stringify(messages));
        if (requests.length === 1) {
          return toolCallResponse("call-1", "exec", { code: HELD_SCRIPT }, "Starting a background check.");
        }
        return requests.length === 2
          ? toolCallResponse("call-2", "write_report", { text: "draft" }, "Writing the report.")
          : textResponse("Done.");
      };
      const made = bypassSession(provider, held.registry, { codeModeService: service, hooks: hook.hooks });
      const phases = await runToEnd(made, "Start the background check and write the report.");

      expect(refusedWhileAwaited).toBe(true);
      expect(held.nested).toEqual(["hold", "list_processes", "finished"]);
      // The hook ran once and its request went nowhere: no third answer.
      expect(hook.calls()).toBe(1);
      expect(requests).toHaveLength(2);
      expect(phases.at(-1)).toMatchObject({ stopReason: "effect_review_required" });
      expect(JSON.stringify(made.state.history)).not.toContain(HOOK_REQUEST);
    } finally {
      await service.wait({ cellId: "1", terminate: true }).catch(() => {});
      await closed.dispose();
    }
  }, 20_000);

  test.each([["the default iteration limit", undefined], ["maxTurns 2, so the limit falls on that re-entry", 2]] as const)(
    "a refusal that lands after a blocking Stop hook answered ends the turn when it re-enters (%s)",
    async (_label, maxTurns) => {
      root = mkdtempSync(join(tmpdir(), "exec-unavailable-after-hook-"));
      const closed = await closedManager(root);
      const service = new QuickJsCodeModeService({ enabled: true });
      try {
        expect(service.enabled()).toBe(true);
        const held = heldScript(closed.manager, service);
        const hook = blockingOnceStopHook();
        const requests: string[] = [];
        const provider = mkProvider();
        provider.chatStream = async (messages): Promise<LLMResponse> => {
          requests.push(JSON.stringify(messages));
          if (requests.length === 1) {
            return toolCallResponse("call-1", "exec", { code: HELD_SCRIPT }, "Starting a background check.");
          }
          return textResponse(requests.length === 2
            ? "The check keeps running in the background."
            : "The checks cannot run now.");
        };
        const made = bypassSession(provider, held.registry, { codeModeService: service, hooks: hook.hooks });
        // Two samples fit; the re-entry after the hook would be the third.
        if (maxTurns !== undefined) Object.assign(made.ctx, { config: { ...(made.ctx.config as object), maxTurns } });
        // The refusal lands once the hook's request has been written to the
        // history: after the hook answered, before the turn re-enters.
        const lock = made.session.state;
        const write = lock.with.bind(lock) as (fn: (value: unknown) => unknown) => Promise<unknown>;
        let refusedAfterWrite: boolean | undefined;
        vi.spyOn(lock, "with").mockImplementation((async (fn: (value: unknown) => unknown) => {
          const written = await write(fn);
          if (refusedAfterWrite === undefined && JSON.stringify(made.state.history).includes(HOOK_REQUEST)) {
            refusedAfterWrite = await held.deliverRefusal();
          }
          return written;
        }) as never);
        const phases = await runToEnd(made, "Start the background check.");

        expect(refusedAfterWrite).toBe(true);
        expect(held.nested).toEqual(["hold", "list_processes", "finished"]);
        expect(hook.calls()).toBe(1);
        // The turn ends with the reason as it re-enters, not with the
        // iteration limit and not after another model call.
        expectExecUnavailableEnd(phases, made.events);
        expect(requests).toHaveLength(2);
        expect(requests.some((request) => request.includes(HOOK_REQUEST))).toBe(false);
        // The request was written before the refusal existed; the reason
        // follows it as the turn's last words.
        const history = made.state.history;
        const requestAt = history.findIndex((message) =>
          message.role === "user" && JSON.stringify(message.content).includes(HOOK_REQUEST));
        expect(requestAt).toBeGreaterThan(-1);
        expect(requestAt).toBeLessThan(history.length - 1);
        expect(history.at(-1)?.role).toBe("assistant");
        expect(String(history.at(-1)?.content)).toContain("Shell commands are disabled for the rest of this session.");
      } finally {
        await service.wait({ cellId: "1", terminate: true }).catch(() => {});
        await closed.dispose();
      }
    },
    20_000,
  );
});

/**
 * Review findings on #3352 (round 6): the iteration limit and the task budget
 * could still end the turn their own way after a refusal landed past the check
 * at the top of the loop, and the next turn dropped it. Neither the user nor
 * the model (or a parent agent) learned that shell commands were paused.
 */
describe("a refusal that lands as the step limit or the task budget ends the turn", () => {
  const SUMMARY = "Partial findings: the build target is web. The checks were not run.";
  const PAUSED = "Shell commands are disabled for the rest of this session.";
  const ANSWER = "The check keeps running in the background.";

  function reportedUsage(totalTokens: number) {
    return { promptTokens: totalTokens - 1, completionTokens: 1, totalTokens, availability: "reported" as const, provenance: "provider" as const };
  }

  async function runWith(
    made: ReturnType<typeof bypassSession>,
    prompt: string,
    opts: Parameters<typeof runTurn>[3] = {},
  ): Promise<PhaseEvent[]> {
    const phases: PhaseEvent[] = [];
    for await (const phase of runTurn(made.session, made.ctx, prompt, opts)) phases.push(phase);
    return phases;
  }

  /** The reason is the turn's last words, in the history the next model call is built from. */
  function expectReasonLast(made: ReturnType<typeof bypassSession>, phases: readonly PhaseEvent[]): void {
    expect(made.state.history.at(-1)?.role).toBe("assistant");
    expect(String(made.state.history.at(-1)?.content)).toContain(PAUSED);
    expect(phases.at(-1)).toMatchObject({ content: expect.stringContaining(PAUSED) });
  }

  test("a refusal that lands while the step-limit summary is written ends the turn with exec_unavailable after the summary", async () => {
    root = mkdtempSync(join(tmpdir(), "exec-unavailable-step-limit-"));
    const closed = await closedManager(root);
    const service = new QuickJsCodeModeService({ enabled: true });
    try {
      expect(service.enabled()).toBe(true);
      const held = heldScript(closed.manager, service);
      const requests: string[] = [];
      let refusedDuringSummary: boolean | undefined;
      const provider = mkProvider();
      provider.chatStream = async (messages): Promise<LLMResponse> => {
        requests.push(JSON.stringify(messages));
        if (requests.length === 1) {
          return toolCallResponse("call-1", "exec", { code: HELD_SCRIPT }, "Starting a background check.");
        }
        // The step-limit summary: the script meets its refusal while it is written.
        refusedDuringSummary = await held.deliverRefusal();
        return textResponse(SUMMARY);
      };
      const made = bypassSession(provider, held.registry, { codeModeService: service });
      Object.assign(made.ctx, { config: { ...(made.ctx.config as object), maxTurns: 1 } });
      const phases = await runWith(made, "Start the background check.", { stepLimitWrapup: {} });

      expect(refusedDuringSummary).toBe(true);
      expect(held.nested).toEqual(["hold", "list_processes", "finished"]);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toContain(STEP_LIMIT_WRAPUP_INSTRUCTION);
      // Not max_turns: a subagent's receipt would say it completed.
      expectExecUnavailableEnd(phases, made.events);
      expectReasonLast(made, phases);
      // The summary that was written stays in the transcript, before the reason.
      expect(phases).toContainEqual(expect.objectContaining({ type: "assistant_text", content: expect.stringContaining(SUMMARY) }));
      expect(String(made.state.history.at(-2)?.content)).toContain(SUMMARY);
    } finally {
      await service.wait({ cellId: "1", terminate: true }).catch(() => {});
      await closed.dispose();
    }
  }, 20_000);

  test("a user stop during the step-limit summary still ends the turn as cancelled when a refusal lands too", async () => {
    root = mkdtempSync(join(tmpdir(), "exec-unavailable-step-limit-stop-"));
    const closed = await closedManager(root);
    const service = new QuickJsCodeModeService({ enabled: true });
    try {
      expect(service.enabled()).toBe(true);
      const held = heldScript(closed.manager, service);
      const stop = new AbortController();
      let requests = 0;
      const provider = mkProvider();
      provider.chatStream = async (): Promise<LLMResponse> => {
        requests += 1;
        if (requests === 1) {
          return toolCallResponse("call-1", "exec", { code: HELD_SCRIPT }, "Starting a background check.");
        }
        expect(await held.deliverRefusal()).toBe(true);
        stop.abort("user stop");
        return textResponse(SUMMARY);
      };
      const made = bypassSession(provider, held.registry, { codeModeService: service });
      Object.assign(made.ctx, { config: { ...(made.ctx.config as object), maxTurns: 1 } });
      const phases = await runWith(made, "Start the background check.", { stepLimitWrapup: {}, signal: stop.signal });

      expect(requests).toBe(2);
      expect(phases.at(-1)).toMatchObject({ stopReason: "cancelled" });
      expect(warnings(made.events, "exec_unavailable")).toEqual([]);
    } finally {
      await service.wait({ cellId: "1", terminate: true }).catch(() => {});
      await closed.dispose();
    }
  }, 20_000);

  test("a refusal that lands as the iteration limit ends a turn without a summary ends it with exec_unavailable", async () => {
    root = mkdtempSync(join(tmpdir(), "exec-unavailable-max-turns-"));
    const closed = await closedManager(root);
    const service = new QuickJsCodeModeService({ enabled: true });
    try {
      expect(service.enabled()).toBe(true);
      const held = heldScript(closed.manager, service);
      let requests = 0;
      const provider = mkProvider();
      provider.chatStream = async (): Promise<LLMResponse> => {
        requests += 1;
        return requests === 1
          ? toolCallResponse("call-1", "exec", { code: HELD_SCRIPT }, "Starting a background check.")
          : textResponse("unexpected");
      };
      const made = bypassSession(provider, held.registry, { codeModeService: service });
      Object.assign(made.ctx, { config: { ...(made.ctx.config as object), maxTurns: 1 } });
      // The refusal lands once the iteration limit has been reached: after the
      // check at the top of the loop, while the limit's exit saves the history
      // (the second save of an unchanged history after the yielded result).
      const lock = made.session.state;
      const write = lock.with.bind(lock) as (fn: (value: unknown) => unknown) => Promise<unknown>;
      let savesAfterResult = 0;
      let refusedAtLimit: boolean | undefined;
      vi.spyOn(lock, "with").mockImplementation((async (fn: (value: unknown) => unknown) => {
        const written = await write(fn);
        if (JSON.stringify(made.state.history).includes("status=yielded")) savesAfterResult += 1;
        if (refusedAtLimit === undefined && savesAfterResult === 2) refusedAtLimit = await held.deliverRefusal();
        return written;
      }) as never);
      const phases = await runWith(made, "Start the background check.");

      expect(refusedAtLimit).toBe(true);
      expect(held.nested).toEqual(["hold", "list_processes", "finished"]);
      expect(requests).toBe(1);
      expectExecUnavailableEnd(phases, made.events);
      expectReasonLast(made, phases);
    } finally {
      await service.wait({ cellId: "1", terminate: true }).catch(() => {});
      await closed.dispose();
    }
  }, 20_000);

  test("a refusal that lands while the answer that reaches the call allocation is written ends the turn with exec_unavailable", async () => {
    root = mkdtempSync(join(tmpdir(), "exec-unavailable-task-calls-"));
    const closed = await closedManager(root);
    const service = new QuickJsCodeModeService({ enabled: true });
    try {
      expect(service.enabled()).toBe(true);
      const held = heldScript(closed.manager, service);
      const requests: string[] = [];
      let refusedDuringAnswer: boolean | undefined;
      const provider = mkProvider();
      provider.chatStream = async (messages): Promise<LLMResponse> => {
        requests.push(JSON.stringify(messages));
        if (requests.length === 1) {
          return toolCallResponse("call-1", "exec", { code: HELD_SCRIPT }, "Starting a background check.");
        }
        refusedDuringAnswer = await held.deliverRefusal();
        return textResponse(ANSWER);
      };
      const made = bypassSession(provider, held.registry, { codeModeService: service });
      // The second call is the last one the allocation admits.
      Object.assign(made.session.config, { taskMaxCalls: 2 });
      const phases = await runWith(made, "Start the background check.");

      expect(refusedDuringAnswer).toBe(true);
      expect(held.nested).toEqual(["hold", "list_processes", "finished"]);
      expect(requests).toHaveLength(2);
      // Not task_budget, whose partial-result summary would drop the reason.
      expectExecUnavailableEnd(phases, made.events);
      expectReasonLast(made, phases);
      expect(String(made.state.history.at(-2)?.content)).toContain(ANSWER);
      expect(JSON.stringify(phases)).not.toContain("stopped at the task budget");
    } finally {
      await service.wait({ cellId: "1", terminate: true }).catch(() => {});
      await closed.dispose();
    }
  }, 20_000);

  test.each([
    ["while the answer that crosses the token allocation is written", "answer"],
    ["while the task-budget checkpoint waits for the user, who stops", "checkpoint"],
  ] as const)("a refusal that lands %s ends the turn with exec_unavailable", async (_label, when) => {
    root = mkdtempSync(join(tmpdir(), "exec-unavailable-task-tokens-"));
    const closed = await closedManager(root);
    const service = new QuickJsCodeModeService({ enabled: true });
    try {
      expect(service.enabled()).toBe(true);
      const held = heldScript(closed.manager, service);
      let requests = 0;
      let refused: boolean | undefined;
      const provider = mkProvider();
      provider.chatStream = async (): Promise<LLMResponse> => {
        requests += 1;
        if (requests === 1) {
          return { ...toolCallResponse("call-1", "exec", { code: HELD_SCRIPT }, "Starting a background check."), usage: reportedUsage(11) };
        }
        if (when === "answer") refused = await held.deliverRefusal();
        // This answer's reported usage crosses the token allocation.
        return { ...textResponse(ANSWER), usage: reportedUsage(100_001) };
      };
      const made = bypassSession(provider, held.registry, { codeModeService: service });
      Object.assign(made.session.services, { runtimeOptions: {
        ...made.session.services.runtimeOptions, interactiveTaskBudget: true, nonInteractive: false,
      } });
      Object.assign(made.session.config, { taskTokenBudget: 100_000 });
      const checkpoint = vi.spyOn(made.session, "requestUserInput").mockImplementation(async () => {
        if (when === "checkpoint") refused = await held.deliverRefusal();
        return { answers: { task_budget: { answers: ["Stop here"] } } };
      });
      const phases = await runWith(made, "Start the background check.");

      expect(refused).toBe(true);
      expect(held.nested).toEqual(["hold", "list_processes", "finished"]);
      expect(requests).toBe(2);
      // Whether to continue is moot once the turn ends with the refusal.
      expect(checkpoint).toHaveBeenCalledTimes(when === "answer" ? 0 : 1);
      expectExecUnavailableEnd(phases, made.events);
      expectReasonLast(made, phases);
    } finally {
      await service.wait({ cellId: "1", terminate: true }).catch(() => {});
      await closed.dispose();
    }
  }, 20_000);

  test("a user stop while the task-budget checkpoint waits keeps that ending when a refusal lands too", async () => {
    root = mkdtempSync(join(tmpdir(), "exec-unavailable-task-stop-"));
    const closed = await closedManager(root);
    const service = new QuickJsCodeModeService({ enabled: true });
    try {
      expect(service.enabled()).toBe(true);
      const held = heldScript(closed.manager, service);
      const stop = new AbortController();
      let requests = 0;
      const provider = mkProvider();
      provider.chatStream = async (): Promise<LLMResponse> => {
        requests += 1;
        return requests === 1
          ? { ...toolCallResponse("call-1", "exec", { code: HELD_SCRIPT }, "Starting a background check."), usage: reportedUsage(11) }
          : { ...textResponse(ANSWER), usage: reportedUsage(100_001) };
      };
      const made = bypassSession(provider, held.registry, { codeModeService: service });
      Object.assign(made.session.services, { runtimeOptions: {
        ...made.session.services.runtimeOptions, interactiveTaskBudget: true, nonInteractive: false,
      } });
      Object.assign(made.session.config, { taskTokenBudget: 100_000 });
      // A stop while the card is shown answers it as declined.
      vi.spyOn(made.session, "requestUserInput").mockImplementation(async () => {
        expect(await held.deliverRefusal()).toBe(true);
        stop.abort("user stop");
        return null;
      });
      const phases = await runWith(made, "Start the background check.", { signal: stop.signal });

      expect(requests).toBe(2);
      expect(phases.at(-1)).toMatchObject({ stopReason: "task_budget" });
      expect(warnings(made.events, "exec_unavailable")).toEqual([]);
    } finally {
      await service.wait({ cellId: "1", terminate: true }).catch(() => {});
      await closed.dispose();
    }
  }, 20_000);
});
