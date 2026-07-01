import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";
import {
  StreamingToolExecutor,
  type StreamingToolUpdate,
} from "./streaming-executor.js";
import { routerFromRegistry } from "./router.js";
import { EventLog } from "../session/event-log.js";
import type { ToolRegistry, ToolDispatchResult } from "../tool-registry.js";
import type { LLMTool, LLMToolCall } from "../llm/types.js";
import type { Tool } from "./types.js";
import { EXCLUSIVE, SHARED_READ } from "./concurrency.js";
import type { ToolUseBlock } from "../session/turn-state.js";
import { createExecCommandTool } from "./system/exec-command.js";
import { UnifiedExecProcessManager } from "../unified-exec/process-manager.js";

function mockRegistry(
  dispatch: (call: LLMToolCall) => Promise<ToolDispatchResult>,
  tools: Tool[] = [],
): ToolRegistry {
  return {
    tools,
    toLLMTools(): LLMTool[] {
      return tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    },
    dispatch,
  };
}

function mockGuardedDispatch(
  dispatch: (call: LLMToolCall) => Promise<ToolDispatchResult>,
  tools: Tool[] = [],
): {
  readonly registry: ToolRegistry;
  readonly runToolUseFn: (
    call: LLMToolCall,
    signal: AbortSignal,
  ) => Promise<ToolDispatchResult>;
} {
  const registry = mockRegistry(dispatch, tools);
  return {
    registry,
    runToolUseFn: (call) => registry.dispatch(call),
  };
}

function makeBlock(id: string, name: string): ToolUseBlock {
  return { type: "tool_use", id, name, input: {} };
}

function makeCall(id: string, name: string): LLMToolCall {
  return { id, name, arguments: "{}" };
}

function markerPids(marker: string): number[] {
  if (process.platform === "win32") return [];
  try {
    const output = execFileSync("ps", ["-eo", "pid=,args="], {
      encoding: "utf8",
    });
    return output
      .split("\n")
      .flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (match === null) return [];
        const pid = Number(match[1]);
        const args = match[2] ?? "";
        return Number.isFinite(pid) && args.includes(marker) ? [pid] : [];
      });
  } catch {
    return [];
  }
}

async function waitForMarker(
  marker: string,
  present: boolean,
): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    const found = markerPids(marker).length > 0;
    if (found === present) return true;
    await delay(100);
  }
  return false;
}

function killMarker(marker: string): void {
  if (process.platform === "win32") return;
  for (const pid of markerPids(marker)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Best-effort test cleanup.
    }
  }
}

/**
 * Build a minimal Tool for tests. Only fields the executor inspects
 * (name, concurrencyClass, isConcurrencySafe, interruptBehavior) are
 * populated; `execute` is a no-op because tests drive dispatch through
 * the registry's `dispatch` hook.
 */
function testTool(overrides: Partial<Tool> & { name: string }): Tool {
  return {
    description: "test",
    inputSchema: { type: "object" },
    execute: async () => ({ content: "" }),
    ...overrides,
  };
}

describe("StreamingToolExecutor (I-65 + I-41)", () => {
  test("completes in submission order (I-65)", async () => {
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async (call) => ({ content: `ok-${call.id}` })),
    });
    for (const id of ["a", "b", "c"]) {
      exec.setConcurrencyClassFor("FileRead", SHARED_READ);
      exec.addTool(makeBlock(id, "FileRead"), makeCall(id, "FileRead"));
    }
    exec.close();
    const results: string[] = [];
    for await (const r of exec.getRemainingResults()) {
      results.push(r.toolCall.id);
    }
    expect(results).toEqual(["a", "b", "c"]);
  });

  test("Bash error cascades sibling-abort", async () => {
    let bashErrored = 0;
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async (call) => {
        if (call.id === "bash1") {
          bashErrored += 1;
          return { content: "bash error", isError: true };
        }
        return { content: "safe" };
      }),
      onSiblingAbort: () => {},
    });
    exec.setConcurrencyClassFor("system.bash", EXCLUSIVE);
    exec.setConcurrencyClassFor("FileRead", SHARED_READ);
    exec.addTool(makeBlock("bash1", "system.bash"), makeCall("bash1", "system.bash"));
    exec.addTool(
      makeBlock("read1", "FileRead"),
      makeCall("read1", "FileRead"),
    );
    exec.close();
    const results: Array<{
      readonly id: string;
      readonly status: string;
      readonly content: string;
    }> = [];
    for await (const r of exec.getRemainingResults()) {
      results.push({
        id: r.toolCall.id,
        status: r.status,
        content: String(r.result.content),
      });
    }
    expect(bashErrored).toBe(1);
    expect(results[0]).toMatchObject({ id: "bash1", status: "completed" });
    // Sibling read gets a synthetic error after bash failed.
    const read = results.find((r) => r.id === "read1");
    expect(read).toBeDefined();
    expect(read?.status).toBe("synthetic_error");
    expect(read?.content).toContain(
      "sibling tool errored; this tool was cancelled",
    );
    expect(read?.content).not.toContain("Streaming fallback occurred");
  });

  test("exec_command error cascades sibling-abort", async () => {
    const dispatched: string[] = [];
    const siblingReasons: string[] = [];
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async (call) => {
        dispatched.push(call.id);
        if (call.name === "exec_command") {
          return { content: "shell failed", isError: true };
        }
        return { content: `ran ${call.name}` };
      }),
      onSiblingAbort: (reason) => {
        siblingReasons.push(reason);
      },
    });
    exec.setConcurrencyClassFor("exec_command", EXCLUSIVE);
    exec.setConcurrencyClassFor("Write", EXCLUSIVE);
    exec.addTool(
      makeBlock("shell1", "exec_command"),
      makeCall("shell1", "exec_command"),
    );
    exec.addTool(makeBlock("write1", "Write"), makeCall("write1", "Write"));
    exec.close();

    const results: Array<{
      readonly id: string;
      readonly status: string;
      readonly content: string;
    }> = [];
    for await (const r of exec.getRemainingResults()) {
      results.push({
        id: r.toolCall.id,
        status: r.status,
        content: String(r.result.content),
      });
    }

    expect(dispatched).toEqual(["shell1"]);
    expect(siblingReasons).toEqual(["bash_error:exec_command"]);
    const write = results.find((r) => r.id === "write1");
    expect(write).toBeDefined();
    expect(write?.status).toBe("synthetic_error");
    expect(write?.content).toContain(
      "sibling tool errored; this tool was cancelled",
    );
  });

  test.skipIf(process.platform === "win32")(
    "interrupted executor abort terminates an active exec_command PTY child",
    async () => {
      const abortController = new AbortController();
      const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
      const marker = `agenc-stream-exec-interrupt-${process.pid}-${Date.now()}`;
      const execCommand = createExecCommandTool({
        cwd: process.cwd(),
        unifiedExecManager: manager,
      });
      const registry = mockRegistry(
        async () => ({ content: "unused" }),
        [execCommand],
      );
      const executor = new StreamingToolExecutor({
        registry,
        abortSignal: abortController.signal,
        runToolUseFn: async (call, signal) => {
          const args = JSON.parse(call.arguments ?? "{}") as Record<string, unknown>;
          Object.defineProperty(args, "__abortSignal", {
            value: signal,
            enumerable: false,
            writable: false,
            configurable: true,
          });
          const result = await execCommand.execute(args);
          return {
            content: result.content,
            isError: result.isError,
            metadata: result.metadata,
          };
        },
      });

      try {
        executor.addTool(
          {
            type: "tool_use",
            id: "shell1",
            name: "exec_command",
            input: {
              cmd: `bash -lc 'exec -a ${marker} sleep 30'`,
              tty: true,
              yield_time_ms: 10_000,
            },
          },
          {
            id: "shell1",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: `bash -lc 'exec -a ${marker} sleep 30'`,
              tty: true,
              yield_time_ms: 10_000,
            }),
          },
        );
        executor.close();
        const drain = (async () => {
          const results = [];
          for await (const result of executor.getRemainingResults()) {
            results.push(result);
          }
          return results;
        })();

        expect(await waitForMarker(marker, true)).toBe(true);
        abortController.abort("interrupted");
        await drain;

        expect(await waitForMarker(marker, false)).toBe(true);
      } finally {
        executor.abort("test_cleanup");
        await manager.closeAll("test_cleanup");
        killMarker(marker);
      }
    },
    10_000,
  );

  test("I-41 re-entrance guard: second discard is no-op", () => {
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async () => ({ content: "" })),
    });
    exec.discard("first");
    // Second call returns immediately without recursion / throw.
    expect(() => exec.discard("second")).not.toThrow();
  });

  test("fails closed when no guarded dispatch path is supplied", async () => {
    let rawDispatchCalled = false;
    const exec = new StreamingToolExecutor({
      registry: mockRegistry(async () => {
        rawDispatchCalled = true;
        return { content: "raw" };
      }, [testTool({ name: "Write" })]),
    });
    exec.addTool(
      makeBlock("w1", "Write"),
      makeCall("w1", "Write"),
    );
    exec.close();

    const results: string[] = [];
    for await (const result of exec.getRemainingResults()) {
      results.push(String(result.result.content));
    }

    expect(rawDispatchCalled).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain("guarded tool dispatch is unavailable");
  });

  // AgenC behavior (`StreamingToolExecutor.ts:69-71`, :412-415, :454-456):
  // discard() flips a boolean; yield paths early-return. The executor
  // does NOT synthesize streaming_fallback results — the caller
  // abandons the output stream.
  test("discard early-returns all yield paths without synthesizing", async () => {
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async () => {
        await new Promise<void>((r) => setTimeout(r, 50));
        return { content: "ok" };
      }),
    });
    exec.setConcurrencyClassFor("Write", EXCLUSIVE);
    exec.addTool(
      makeBlock("w1", "Write"),
      makeCall("w1", "Write"),
    );
    exec.addTool(
      makeBlock("w2", "Write"),
      makeCall("w2", "Write"),
    );
    exec.discard("fallback");

    // getCompletedResults is a no-op after discard.
    const sync = Array.from(exec.getCompletedResults());
    expect(sync).toEqual([]);

    // getRemainingResults also returns empty immediately.
    const async_: unknown[] = [];
    for await (const r of exec.getRemainingResults()) async_.push(r);
    expect(async_).toEqual([]);
  });

  test("discard aborts in-flight child signals without bubbling to parent", async () => {
    let started!: () => void;
    let aborted!: (reason: string) => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const abortedPromise = new Promise<string>((resolve) => {
      aborted = resolve;
    });
    const parentAbort = new AbortController();
    const writeTool = testTool({ name: "Write", concurrencyClass: EXCLUSIVE });
    const exec = new StreamingToolExecutor({
      registry: mockRegistry(async () => ({ content: "unused" }), [writeTool]),
      parentAbortController: parentAbort,
      runToolUseFn: async (_call, signal) => {
        started();
        return await new Promise<ToolDispatchResult>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted(String(signal.reason ?? ""));
              resolve({ content: "aborted", isError: true });
            },
            { once: true },
          );
        });
      },
    });

    exec.addTool(makeBlock("w1", "Write"), makeCall("w1", "Write"));
    exec.dispatchPending();
    await startedPromise;

    exec.discard("streaming_fallback");

    const reason = await Promise.race([
      abortedPromise,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("not-aborted"), 50),
      ),
    ]);
    expect(reason).toBe("streaming_fallback");
    expect(parentAbort.signal.aborted).toBe(false);
  });

  test("discarded Bash abort does not emit sibling-abort warnings", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const siblingReasons: string[] = [];
    const bashTool = testTool({
      name: "system.bash",
      concurrencyClass: EXCLUSIVE,
    });
    const exec = new StreamingToolExecutor({
      registry: mockRegistry(async () => ({ content: "unused" }), [bashTool]),
      runToolUseFn: async (_call, signal) => {
        started();
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return { content: "aborted bash", isError: true };
      },
      onSiblingAbort: (reason) => {
        siblingReasons.push(reason);
      },
    });

    exec.addTool(
      makeBlock("bash1", "system.bash"),
      makeCall("bash1", "system.bash"),
    );
    exec.dispatchPending();
    await startedPromise;

    exec.discard("streaming_fallback");

    for (
      let tick = 0;
      exec.getToolStates()[0]?.status === "executing" && tick < 10;
      tick += 1
    ) {
      await Promise.resolve();
    }
    expect(exec.getToolStates()[0]?.status).toBe("completed");
    expect(siblingReasons).toEqual([]);
  });

  test("live dispatch accepts model tool aliases before unknown-tool synthesis", async () => {
    const execute = vi.fn(async (args: Record<string, unknown>) => ({
      content: `read ${String(args.file_path)}`,
    }));
    const readTool = testTool({
      name: "FileRead",
      concurrencyClass: SHARED_READ,
      execute,
    });
    const registry = mockRegistry(
      async () => ({ content: "registry dispatch should not run", isError: true }),
      [readTool],
    );
    const exec = new StreamingToolExecutor({
      registry,
      liveToolDispatch: {
        router: routerFromRegistry(registry),
        options: {
          session: {
            eventLog: new EventLog(),
            services: {},
          } as never,
          turn: { subId: "turn-read-alias" } as never,
          tracker: {
            appendFileDiff: () => {},
            snapshot: () => [],
            clear: () => {},
          },
          approvalPolicy: "never",
          sandboxMode: "workspace_write",
        },
      },
    });
    const call: LLMToolCall = {
      id: "read-alias",
      name: "Read",
      arguments: JSON.stringify({ file_path: "main.c" }),
    };

    exec.addTool(makeBlock(call.id, call.name), call);
    exec.close();
    const results = [];
    for await (const result of exec.getRemainingResults()) {
      results.push(result);
    }

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ file_path: "main.c" }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.result.content).toBe("read main.c");
    expect(results[0]!.result.content).not.toContain("No such tool available");
  });

  test("external abort reasons are preserved in synthetic terminal results", async () => {
    const abortCtl = new AbortController();
    abortCtl.abort("mode_changed");
    const writeTool = testTool({
      name: "Write",
      concurrencyClass: EXCLUSIVE,
    });
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async () => ({ content: "ok" }), [writeTool]),
      abortSignal: abortCtl.signal,
    });

    exec.addTool(
      makeBlock("m1", "Write"),
      makeCall("m1", "Write"),
    );
    exec.close();

    const results: string[] = [];
    for await (const result of exec.getRemainingResults()) {
      results.push(String(result.result.content));
    }

    expect(results).toHaveLength(1);
    expect(results[0]).toContain("permission mode changed mid-execution");
  });

  test("uses tool.isConcurrencySafe for per-call downgrade", async () => {
    let active = 0;
    let peak = 0;
    const tool: Tool = {
      name: "FileRead",
      description: "conditionally parallel",
      inputSchema: { type: "object" },
      concurrencyClass: SHARED_READ,
      isConcurrencySafe: (args) => args["safe"] === true,
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { content: "ok" };
      },
    };
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async (call) => {
        const parsed = call.arguments ? JSON.parse(call.arguments) : {};
        const result = await tool.execute(parsed);
        return { content: result.content, isError: result.isError };
      }, [tool]),
    });
    exec.addTool(
      makeBlock("unsafe", "FileRead"),
      { id: "unsafe", name: "FileRead", arguments: '{"safe":false}' },
    );
    exec.addTool(
      makeBlock("safe", "FileRead"),
      { id: "safe", name: "FileRead", arguments: '{"safe":true}' },
    );
    exec.close();

    const seenIds: string[] = [];
    for await (const result of exec.getRemainingResults()) {
      seenIds.push(result.toolCall.id);
    }

    expect(seenIds).toEqual(["unsafe", "safe"]);
    expect(peak).toBe(1);
  });

  test("normalizes array-shaped parsed arguments before concurrency hooks", async () => {
    let observedArgs: Record<string, unknown> | undefined;
    const tool: Tool = {
      name: "FileRead",
      description: "array args should be malformed for classification",
      inputSchema: { type: "object" },
      concurrencyClass: SHARED_READ,
      isConcurrencySafe: (args) => {
        observedArgs = args;
        return true;
      },
      execute: async () => ({ content: "ok" }),
    };
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async () => ({ content: "ok" }), [tool]),
    });

    exec.addTool(makeBlock("array-args", "FileRead"), {
      id: "array-args",
      name: "FileRead",
      arguments: "[\"spoof\"]",
    });
    exec.close();

    const seenIds: string[] = [];
    for await (const result of exec.getRemainingResults()) {
      seenIds.push(result.toolCall.id);
    }

    expect(seenIds).toEqual(["array-args"]);
    expect(observedArgs).toEqual({});
    expect(Array.isArray(observedArgs)).toBe(false);
  });

  test("maxConcurrency caps safe tools without changing yield order", async () => {
    let active = 0;
    let peak = 0;
    const readTool = testTool({
      name: "FileRead",
      isConcurrencySafe: () => true,
    });
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async (call) => {
        active += 1;
        peak = Math.max(peak, active);
        const delay = call.id === "a" ? 10 : 1;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        active -= 1;
        return { content: `ok-${call.id}` };
      }, [readTool]),
      maxConcurrency: 1,
    });

    for (const id of ["a", "b", "c"]) {
      exec.addTool(makeBlock(id, "FileRead"), makeCall(id, "FileRead"));
    }
    exec.close();

    const seenIds: string[] = [];
    for await (const result of exec.getRemainingResults()) {
      seenIds.push(result.toolCall.id);
    }

    expect(seenIds).toEqual(["a", "b", "c"]);
    expect(peak).toBe(1);
  });
});

describe("StreamingToolExecutor AgenC behavior (T6)", () => {
  test("unknown tool pre-synthesizes No such tool available", async () => {
    // AgenC StreamingToolExecutor.ts:77-102 — the executor must
    // pre-synthesize a deterministic tool_result for an unknown tool
    // so the tool_use block never reaches the model unpaired.
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async () => ({ content: "should not dispatch" })),
    });
    exec.addTool(makeBlock("u1", "no.such.tool"), makeCall("u1", "no.such.tool"));
    exec.close();

    const results: Array<{ id: string; content: string; isError: boolean }> = [];
    for await (const r of exec.getRemainingResults()) {
      results.push({
        id: r.toolCall.id,
        content: String(r.result.content),
        isError: r.result.isError === true,
      });
    }
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("u1");
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.content).toContain("No such tool available: no.such.tool");
  });

  test("addTool on a closed executor still emits a synthetic completion (regression: pwd-storm silent drop)", async () => {
    // The pwd-storm bug: when the executor was already closed/aborting
    // by the time `addTool` was called, the prior `if (this.closed ||
    // this.isAborting) return;` silently dropped the call. Upstream
    // (queueStreamingToolCall) had already emitted the
    // `tool_call_started` event, so the TUI showed the call line but
    // no `tool_call_completed` ever followed, no `tool_result` got
    // pushed to state.messages, the model on the next turn iteration
    // saw silence for its tool call, and re-emitted the same call
    // until it gave up. This pins the synthetic-completion fix.
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async () => ({ content: "should not dispatch" })),
    });
    exec.close();
    // After close, addTool must still produce a tracked entry with a
    // synthetic error result so getRemainingResults yields the
    // pairing tool_call_completed.
    exec.addTool(makeBlock("c1", "FileRead"), makeCall("c1", "FileRead"));

    const results: Array<{ id: string; content: string; isError: boolean }> = [];
    for await (const r of exec.getRemainingResults()) {
      results.push({
        id: r.toolCall.id,
        content: String(r.result.content),
        isError: r.result.isError === true,
      });
    }
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("c1");
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.content).toContain("closed executor");
    expect(results[0]!.content).toContain("FileRead");
  });

  test("head-of-line break: executing non-safe tool blocks downstream yields", async () => {
    // AgenC :436-438 — while a non-concurrency-safe tool is
    // still executing, downstream completed/pending results must not
    // be yielded out of order.
    let resolveExclusive!: () => void;
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async (call) => {
        if (call.id === "x1") {
          await new Promise<void>((r) => {
            resolveExclusive = r;
          });
          return { content: "x-done" };
        }
        return { content: `r-${call.id}` };
      }),
    });
    exec.setConcurrencyClassFor("Write", EXCLUSIVE);
    exec.setConcurrencyClassFor("FileRead", SHARED_READ);
    exec.addTool(
      makeBlock("x1", "Write"),
      makeCall("x1", "Write"),
    );
    exec.addTool(
      makeBlock("r1", "FileRead"),
      makeCall("r1", "FileRead"),
    );
    exec.dispatchPending();
    exec.close();

    // While x1 is still executing, only x1 is in queue. r1 is queued
    // but cannot dispatch until x1 finishes (exclusive gate).
    // getCompletedResults should yield nothing yet.
    await new Promise<void>((r) => setTimeout(r, 5));
    const midflight = Array.from(exec.getCompletedResults());
    expect(midflight).toEqual([]);

    resolveExclusive();
    const results: string[] = [];
    for await (const r of exec.getRemainingResults()) {
      results.push(r.toolCall.id);
    }
    expect(results).toEqual(["x1", "r1"]);
  });

  test("progress events yield through getRemainingUpdates", async () => {
    // AgenC :366-378, :419-422, :453-490 — progress messages
    // ride the same iterator as terminal results and wake the
    // drain loop via Promise.race.
    let triggerProgress!: () => void;
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async (call) => {
        // Progress is driven externally; dispatch just waits.
        await new Promise<void>((r) => {
          triggerProgress = () => {
            // synthesize a progress event mid-dispatch
            exec.emitProgress(call.id, "chunk-1");
            r();
          };
        });
        return { content: "done" };
      }),
    });
    exec.setConcurrencyClassFor("FileRead", SHARED_READ);
    exec.addTool(
      makeBlock("p1", "FileRead"),
      makeCall("p1", "FileRead"),
    );
    exec.close();

    // Fire progress after the loop starts.
    setTimeout(() => triggerProgress?.(), 10);

    const seen: StreamingToolUpdate[] = [];
    for await (const update of exec.getRemainingUpdates()) {
      seen.push(update);
    }
    const progressEvents = seen.filter((s) => s.kind === "progress");
    const resultEvents = seen.filter((s) => s.kind === "result");
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(resultEvents.length).toBe(1);
  });

  test("child abort bubbles to parent (non-sibling_error)", async () => {
    // AgenC :301-318 — when the child abort fires for a reason
    // OTHER than 'sibling_error' (e.g. permission reject, ExitPlanMode
    // clear+auto), the parent abortController must also abort so the
    // turn loop ends instead of sending REJECT_MESSAGE to the model.
    const parent = new AbortController();
    const readTool = testTool({
      name: "FileRead",
      concurrencyClass: SHARED_READ,
    });
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async (_call, signal?: unknown) => {
        void _call;
        void signal;
        // Simulate permission-dialog reject by aborting sibling
        // with a non-sibling_error reason once dispatch starts.
        return await new Promise<ToolDispatchResult>((_resolve, reject) => {
          setTimeout(() => {
            exec.abort("mode_changed");
            reject(new Error("mode_changed"));
          }, 5);
        });
      }, [readTool]),
      parentAbortController: parent,
    });
    exec.addTool(
      makeBlock("r1", "FileRead"),
      makeCall("r1", "FileRead"),
    );
    exec.close();
    // Drain — this triggers abort and lets the bubble-up run.
    try {
      for await (const _r of exec.getRemainingResults()) void _r;
    } catch {
      /* ignore */
    }
    // Parent should be aborted (non-sibling_error path).
    expect(parent.signal.aborted).toBe(true);
  });

  test("child abort with sibling_error does NOT bubble to parent", async () => {
    // AgenC :306-315 — sibling_error is the dedicated internal
    // cascade and must NOT propagate to the parent controller.
    const parent = new AbortController();
    const bashTool = testTool({
      name: "system.bash",
      concurrencyClass: EXCLUSIVE,
    });
    const readTool = testTool({
      name: "FileRead",
      concurrencyClass: SHARED_READ,
    });
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async (call) => {
        if (call.id === "bash1") return { content: "err", isError: true };
        // read1 would get sibling_error cascade.
        await new Promise<void>((r) => setTimeout(r, 50));
        return { content: "read-ok" };
      }, [bashTool, readTool]),
      parentAbortController: parent,
      onSiblingAbort: () => {},
    });
    exec.addTool(
      makeBlock("bash1", "system.bash"),
      makeCall("bash1", "system.bash"),
    );
    exec.addTool(
      makeBlock("read1", "FileRead"),
      makeCall("read1", "FileRead"),
    );
    exec.close();
    for await (const _r of exec.getRemainingResults()) void _r;
    expect(parent.signal.aborted).toBe(false);
  });

  test("interruptBehavior('block') continues past interrupt", async () => {
    // AgenC :219-228 — tools that declare interruptBehavior() ==
    // 'block' must NOT be cancelled when the parent abortController
    // is aborted with reason 'interrupt'. They continue to their
    // natural completion.
    const abortCtl = new AbortController();
    const writeTool = testTool({
      name: "Write",
      concurrencyClass: EXCLUSIVE,
      interruptBehavior: () => "block",
    });
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async () => ({ content: "completed-anyway" }), [
        writeTool,
      ]),
      abortSignal: abortCtl.signal,
    });
    abortCtl.abort("interrupt");
    exec.addTool(
      makeBlock("w1", "Write"),
      makeCall("w1", "Write"),
    );
    exec.close();

    const results: Array<{ status: string; content: string }> = [];
    for await (const r of exec.getRemainingResults()) {
      results.push({ status: r.status, content: String(r.result.content) });
    }
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("completed");
    expect(results[0]!.content).toBe("completed-anyway");
  });

  test("interruptBehavior('cancel') synthesizes user_interrupted", async () => {
    // AgenC :223-226 — interruptBehavior === 'cancel' AND abort
    // reason === 'interrupt' → user_interrupted terminal result.
    const abortCtl = new AbortController();
    const writeTool = testTool({
      name: "Write",
      concurrencyClass: EXCLUSIVE,
      interruptBehavior: () => "cancel",
    });
    const exec = new StreamingToolExecutor({
      ...mockGuardedDispatch(async () => ({ content: "should-not-run" }), [
        writeTool,
      ]),
      abortSignal: abortCtl.signal,
    });
    abortCtl.abort("interrupt");
    exec.addTool(
      makeBlock("w1", "Write"),
      makeCall("w1", "Write"),
    );
    exec.close();

    const results: Array<{ status: string; content: string }> = [];
    for await (const r of exec.getRemainingResults()) {
      results.push({ status: r.status, content: String(r.result.content) });
    }
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("synthetic_error");
    expect(results[0]!.content).toContain("user interrupted");
  });
});
