import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import type { LLMResponse } from "../../src/llm/types.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Event } from "../../src/session/session.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { createCodeModeTools } from "../../src/tools/code-mode/tools.js";
import type { CodeModeService, CodeModeTurnHost } from "../../src/tools/code-mode/types.js";
import { createExecCommandTool } from "../../src/tools/system/exec-command.js";
import { createListProcessesTool } from "../../src/tools/system/list-processes.js";
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

describe("exec_unavailable ends the turn", () => {
  test("a model that keeps trying shell commands is stopped at the first refusal", async () => {
    root = mkdtempSync(join(tmpdir(), "exec-unavailable-turn-"));
    const closed = await closedManager(root);
    try {
      const execTool = bindExplicitDangerBoundary(
        createExecCommandTool({ unifiedExecManager: closed.manager, cwd: root }),
      );
      let samples = 0;
      const shellCalls: string[] = [];
      const provider = mkProvider();
      provider.chatStream = async (): Promise<LLMResponse> => {
        samples += 1;
        const wantsTool = samples <= 20;
        return {
          content: wantsTool ? "Let me try another command." : "finished",
          toolCalls: wantsTool
            ? [{
                id: `call-${samples}`,
                name: "exec_command",
                // Different every time, as the model did: the exact-repeat
                // backstop never sees an identical call.
                arguments: JSON.stringify({ cmd: `ls -la attempt-${samples}` }),
              }]
            : [],
          usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
          model: "test-model",
          finishReason: wantsTool ? "tool_calls" : "stop",
        };
      };
      const shell = {
        name: "exec_command",
        description: "Run a shell command",
        inputSchema: { type: "object" },
        recoveryCategory: "side-effecting",
        execute: async (args: Record<string, unknown>) => {
          shellCalls.push(String(args.cmd));
          return execTool.execute(args);
        },
      };
      const registry = {
        tools: [shell],
        toLLMTools: () => [],
        dispatch: shell.execute,
      } as unknown as ToolRegistry;
      const { session, events, state, ctx } = bypassSession(provider, registry);

      const phases: PhaseEvent[] = [];
      for await (const phase of runTurn(session, ctx, "Build the site and check it with the shell.")) {
        phases.push(phase);
      }

      // One sample and one refused call: no second chance to loop.
      expect(samples).toBe(1);
      expect(shellCalls).toEqual(["ls -la attempt-1"]);
      const results = events.flatMap((event) =>
        event.msg.type === "tool_call_completed" ? [String(event.msg.payload.result)] : [],
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toContain('"code":"exec_unavailable"');
      expect(results[0]).toContain("Do not call exec_command");

      expect(phases.at(-1)).toMatchObject({ stopReason: "exec_unavailable" });
      expect(terminals(events)).toEqual([
        expect.objectContaining({ outcome: "errored", failureCode: "exec_unavailable" }),
      ]);
      // The user sees why, and what to do, as the turn's last words.
      const [warning, ...rest] = warnings(events, "exec_unavailable");
      expect(rest).toEqual([]);
      expect(warning?.msg.payload).toMatchObject({
        message: expect.stringContaining("Shell commands are disabled for the rest of this session."),
      });
      expect(JSON.stringify(warning?.msg.payload)).toContain("Start a new session to run shell commands.");
      const lastAssistant = [...state.history].reverse().find((message) => message.role === "assistant");
      expect(String(lastAssistant?.content)).toContain("Shell commands are disabled for the rest of this session.");
      expect(warnings(events, "no_progress_detected")).toEqual([]);
    } finally {
      await closed.dispose();
    }
  });

  test("a refusal inside a code-mode script ends the turn even when the script catches it", async () => {
    root = mkdtempSync(join(tmpdir(), "exec-unavailable-code-mode-"));
    const closed = await closedManager(root);
    try {
      const listProcesses = createListProcessesTool({ unifiedExecManager: closed.manager });
      let nestedCalls = 0;
      const caught: string[] = [];
      let host: CodeModeTurnHost | undefined;
      // Runs the script `try { await tools.list_processes() } catch (error) { text("caught") }`.
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
      let samples = 0;
      const provider = mkProvider();
      provider.chatStream = async (): Promise<LLMResponse> => {
        samples += 1;
        const wantsTool = samples <= 20;
        return {
          content: wantsTool ? "Let me check the processes from a script." : "finished",
          toolCalls: wantsTool
            ? [{
                id: `call-${samples}`,
                name: "exec",
                arguments: JSON.stringify({
                  code: `try { await tools.list_processes() } catch (error) { text("caught ${samples}") }`,
                }),
              }]
            : [],
          usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
          model: "test-model",
          finishReason: wantsTool ? "tool_calls" : "stop",
        };
      };
      const registry = {
        tools: [codeExec],
        toLLMTools: () => [],
        dispatch: async () => ({ content: "", isError: false }),
        dispatchCodeModeNestedTool: async (call: { readonly input?: unknown }) => {
          nestedCalls += 1;
          return listProcesses.execute((call.input ?? {}) as Record<string, unknown>);
        },
      } as unknown as ToolRegistry;
      const { session, events, ctx } = bypassSession(provider, registry, { codeModeService: service });

      const phases: PhaseEvent[] = [];
      for await (const phase of runTurn(session, ctx, "Check the processes with a script.")) {
        phases.push(phase);
      }

      // The script caught the refusal and finished; the turn still ended.
      expect(caught).toHaveLength(1);
      expect(caught[0]).toContain('"code":"exec_unavailable"');
      expect(samples).toBe(1);
      expect(nestedCalls).toBe(1);
      expect(phases.at(-1)).toMatchObject({ stopReason: "exec_unavailable" });
      expect(terminals(events)).toEqual([
        expect.objectContaining({ outcome: "errored", failureCode: "exec_unavailable" }),
      ]);
      const [warning, ...rest] = warnings(events, "exec_unavailable");
      expect(rest).toEqual([]);
      expect(warning?.msg.payload).toMatchObject({
        message: expect.stringContaining("Shell commands are disabled for the rest of this session."),
      });
    } finally {
      await closed.dispose();
    }
  });
});
