/**
 * Calls from one model response: literal read-only exec_command inspections
 * run side by side; every other command is exclusive. Results are recorded in
 * the order the model submitted the calls either way.
 */
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { execCommandRunsConcurrently } from "./read-only-shell-concurrency.js";
import { createExecCommandTool } from "./system/exec-command.js";
import { StreamingToolExecutor, type StreamingToolResult, type TrackedTool } from "./streaming-executor.js";
import type { ToolRegistry, ToolDispatchResult } from "../tool-registry.js";
import type { LLMToolCall } from "../llm/types.js";
import type { Tool } from "./types.js";
import type { ToolUseBlock } from "../session/turn-state.js";

const cwd = "/workspace";
const call = (cmd: string, extra: Record<string, unknown> = {}) => ({ cmd, workdir: cwd, ...extra });

describe("read-only exec_command concurrency", () => {
  test.each([
    "ls -la",
    "cat README.md",
    "wc -l data/orders.csv",
    "head -n 3 src/main.js",
    "grep -n amount src/read.js",
    "git log --oneline -n 3",
    "pwd",
  ])("runs the literal inspection %s alongside other calls", (cmd) => {
    expect(execCommandRunsConcurrently(call(cmd), cwd)).toBe(true);
  });

  test.each([
    "ls | wc -l",
    "cat README.md && cat package.json",
    "find . -maxdepth 2 -type f -not -path './.git/*' -print | sort",
    "for f in src/*.js; do printf '%s\\n' \"$f\"; cat \"$f\"; done",
    "git status --short --branch",
  ])("runs the read-only command line %s alongside other calls", (cmd) => {
    expect(execCommandRunsConcurrently(call(cmd), cwd)).toBe(true);
  });

  test.each([
    "touch out.txt",
    "printf 'a\\n' > out.txt",
    "mkdir -p build",
    "npm test",
    "rm -rf build",
    "sed -i s/a/b/ f",
    "find . -delete",
    "cat a; touch b",
    "git commit -m x",
    "python3 -c 'print(1)'",
  ])("keeps %s exclusive", (cmd) => {
    expect(execCommandRunsConcurrently(call(cmd), cwd)).toBe(false);
  });

  test.each([
    { detach: true },
    { tty: true },
    { login: true },
    { dangerouslyDisableSandbox: true },
    { sandbox_permissions: "require_escalated" },
  ])("keeps a read-only command exclusive with %o", (extra) => {
    expect(execCommandRunsConcurrently(call("ls -la", extra), cwd)).toBe(false);
  });

  test("the exec_command tool declares the same classification", () => {
    const tool = createExecCommandTool({ cwd });
    expect(tool.isConcurrencySafe?.(call("cat README.md"))).toBe(true);
    expect(tool.isConcurrencySafe?.(call("touch x"))).toBe(false);
  });
});

function block(id: string): ToolUseBlock {
  return { type: "tool_use", id, name: "exec_command", input: {} };
}

function execCall(id: string, cmd: string): LLMToolCall {
  return { id, name: "exec_command", arguments: JSON.stringify(call(cmd)) };
}

/** The real exec_command definition with a scripted dispatch per command. */
function harness(durations: Record<string, number>) {
  const tool: Tool = createExecCommandTool({ cwd });
  let active = 0;
  const timeline: string[] = [];
  const overlaps: Record<string, number> = {};
  const registry: ToolRegistry = {
    tools: [tool],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "unused" }),
  } as unknown as ToolRegistry;
  const exec = new StreamingToolExecutor({
    registry,
    runToolUseFn: async (toolCall: LLMToolCall): Promise<ToolDispatchResult> => {
      const cmd = (JSON.parse(toolCall.arguments) as { cmd: string }).cmd;
      active += 1;
      overlaps[toolCall.id] = Math.max(overlaps[toolCall.id] ?? 0, active);
      timeline.push(`start:${toolCall.id}`);
      await delay(durations[toolCall.id] ?? 1);
      timeline.push(`end:${toolCall.id}`);
      active -= 1;
      return { content: `ran ${cmd}` };
    },
  });
  return { exec, timeline, overlaps, active: () => active };
}

async function collect(exec: StreamingToolExecutor): Promise<StreamingToolResult[]> {
  const results: StreamingToolResult[] = [];
  for await (const result of exec.getRemainingResults()) results.push(result);
  return results;
}

async function drain(exec: StreamingToolExecutor): Promise<string[]> {
  const seen: string[] = [];
  for await (const result of exec.getRemainingResults()) seen.push(result.toolCall.id);
  return seen;
}

describe("executor scheduling of exec_command calls from one response", () => {
  test("three read-only inspections run concurrently and report in submission order", async () => {
    const { exec, timeline, overlaps } = harness({ a: 40, b: 20, c: 1 });
    exec.addTool(block("a"), execCall("a", "ls -la"));
    exec.addTool(block("b"), execCall("b", "cat README.md"));
    exec.addTool(block("c"), execCall("c", "wc -l data/orders.csv"));
    exec.dispatchPending();
    exec.close();
    const seen = await drain(exec);
    expect(timeline.slice(0, 3)).toEqual(["start:a", "start:b", "start:c"]);
    expect(Math.max(...Object.values(overlaps))).toBe(3);
    expect(seen).toEqual(["a", "b", "c"]);
  });

  test("a non-read-only command runs alone between read-only ones, in order", async () => {
    const { exec, timeline } = harness({ a: 10, b: 10, c: 10, d: 1 });
    exec.addTool(block("a"), execCall("a", "ls -la"));
    exec.addTool(block("b"), execCall("b", "touch out.txt"));
    exec.addTool(block("c"), execCall("c", "cat README.md"));
    exec.addTool(block("d"), execCall("d", "cat package.json"));
    exec.dispatchPending();
    exec.close();
    const seen = await drain(exec);
    // b waits for a, and c/d wait for b: nothing overlaps the write.
    expect(timeline.indexOf("start:b")).toBeGreaterThan(timeline.indexOf("end:a"));
    expect(timeline.indexOf("start:c")).toBeGreaterThan(timeline.indexOf("end:b"));
    expect(timeline.indexOf("start:d")).toBeGreaterThan(timeline.indexOf("end:b"));
    expect(seen).toEqual(["a", "b", "c", "d"]);
  });

  test("non-read-only commands keep running one at a time", async () => {
    const { exec, overlaps } = harness({ a: 5, b: 5, c: 5 });
    exec.addTool(block("a"), execCall("a", "touch one"));
    exec.addTool(block("b"), execCall("b", "touch two"));
    exec.addTool(block("c"), execCall("c", "mkdir -p three"));
    exec.dispatchPending();
    exec.close();
    expect(await drain(exec)).toEqual(["a", "b", "c"]);
    expect(Math.max(...Object.values(overlaps))).toBe(1);
  });
});

describe("a read-only call that cannot take the read-only route", () => {
  /**
   * Router stand-in: calls named in `ordinary` miss the read-only route, as
   * when its sandbox cannot be prepared, and run through the hook the
   * executor hands to concurrently scheduled shell calls. `arrive` delays a
   * call's route decision, as the router's own checks do before it.
   */
  function routedHarness(ordinary: ReadonlySet<string>, durations: Record<string, number | Promise<void>>,
    abortSignal?: AbortSignal, arrive: Record<string, number> = {}) {
    const tool: Tool = createExecCommandTool({ cwd });
    const registry = {
      tools: [tool],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "unused" }),
    } as unknown as ToolRegistry;
    const timeline: string[] = [];
    const concurrentDuring: Record<string, number[]> = {};
    let active = 0;
    const router = {
      toolSupportsParallel: () => false,
      async dispatchModelToolCall(
        toolCall: LLMToolCall,
        opts: {
          readonly runAloneOffReadOnlyRoute?: <T>(run: () => Promise<T>) => Promise<T>;
          readonly signal?: AbortSignal;
        },
      ): Promise<ToolDispatchResult> {
        const run = async (): Promise<ToolDispatchResult> => {
          active += 1;
          timeline.push(`start:${toolCall.id}`);
          (concurrentDuring[toolCall.id] ??= []).push(active);
          const duration = durations[toolCall.id] ?? 1;
          if (typeof duration === "number") {
            await delay(duration, undefined, { signal: opts.signal });
          } else {
            await duration;
          }
          (concurrentDuring[toolCall.id] ??= []).push(active);
          timeline.push(`end:${toolCall.id}`);
          active -= 1;
          return { content: `ran ${toolCall.id}` };
        };
        const arrival = arrive[toolCall.id];
        if (arrival !== undefined) await delay(arrival, undefined, { signal: opts.signal });
        return ordinary.has(toolCall.id) && opts.runAloneOffReadOnlyRoute !== undefined
          ? opts.runAloneOffReadOnlyRoute(run)
          : run();
      },
    };
    const exec = new StreamingToolExecutor({
      registry,
      liveToolDispatch: { router: router as never, options: {} as never },
      ...(abortSignal !== undefined ? { abortSignal } : {}),
    });
    return { exec, timeline, concurrentDuring };
  }

  test("waits for the other calls of its batch and runs alone, before later writes", async () => {
    const { exec, timeline, concurrentDuring } = routedHarness(new Set(["b"]), { a: 30, b: 5, c: 30, d: 1 });
    exec.addTool(block("a"), execCall("a", "ls -la"));
    exec.addTool(block("b"), execCall("b", "cat README.md | wc -l"));
    exec.addTool(block("c"), execCall("c", "cat package.json"));
    exec.addTool(block("d"), execCall("d", "touch out.txt"));
    exec.dispatchPending();
    exec.close();
    const seen = await drain(exec);
    expect(concurrentDuring.b).toEqual([1, 1]);
    expect(timeline.indexOf("start:b")).toBeGreaterThan(timeline.indexOf("end:a"));
    expect(timeline.indexOf("start:b")).toBeGreaterThan(timeline.indexOf("end:c"));
    expect(timeline.indexOf("start:d")).toBeGreaterThan(timeline.indexOf("end:b"));
    expect(seen).toEqual(["a", "b", "c", "d"]);
  });

  test("two such calls take turns instead of waiting for each other", async () => {
    const { exec, timeline, concurrentDuring } = routedHarness(new Set(["a", "b"]), { a: 10, b: 10, c: 10 });
    exec.addTool(block("a"), execCall("a", "ls | wc -l"));
    exec.addTool(block("b"), execCall("b", "cat README.md | wc -l"));
    exec.addTool(block("c"), execCall("c", "pwd"));
    exec.dispatchPending();
    exec.close();
    expect(await drain(exec)).toEqual(["a", "b", "c"]);
    expect(concurrentDuring.a).toEqual([1, 1]);
    expect(concurrentDuring.b).toEqual([1, 1]);
    expect(timeline.filter((entry) => entry.startsWith("start:"))).toHaveLength(3);
  });

  // Seen on macOS: a zsh session shell keeps read-only command lines off the
  // read-only route, so two of them from one response both fall back. The
  // first waits for the second while that one still runs its route checks;
  // the second then waits for the first one's turn.
  test.each([
    { late: "b", order: ["a", "b"] },
    { late: "a", order: ["b", "a"] },
  ])("a fallback that arrives later ($late) wakes the one already waiting", async ({ late, order }) => {
    const { exec, timeline, concurrentDuring } = routedHarness(
      new Set(["a", "b"]), { a: 1, b: 1 }, undefined, { [late]: 20 },
    );
    exec.addTool(block("a"), execCall("a", "cat package.json | head -3"));
    exec.addTool(block("b"), execCall("b", "cat README.md | head -3"));
    exec.dispatchPending();
    exec.close();
    const outcome = await Promise.race([drain(exec), delay(2_000).then(() => "deadlocked" as const)]);
    if (outcome === "deadlocked") exec.discard("test cleanup");
    expect(outcome).toEqual(["a", "b"]);
    expect(timeline).toEqual(order.flatMap((id) => [`start:${id}`, `end:${id}`]));
    expect(concurrentDuring.a).toEqual([1, 1]);
    expect(concurrentDuring.b).toEqual([1, 1]);
  });

  test("calls that take the read-only route still overlap", async () => {
    const { exec, concurrentDuring } = routedHarness(new Set(), { a: 20, b: 20, c: 20 });
    exec.addTool(block("a"), execCall("a", "ls | wc -l"));
    exec.addTool(block("b"), execCall("b", "cat README.md && cat package.json"));
    exec.addTool(block("c"), execCall("c", "git status --short"));
    exec.dispatchPending();
    exec.close();
    expect(await drain(exec)).toEqual(["a", "b", "c"]);
    expect(Math.max(...Object.values(concurrentDuring).flat())).toBe(3);
  });

  test("cancelling a waiting fallback preserves the active fallback's exclusive turn", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const { exec, timeline, concurrentDuring } = routedHarness(
      new Set(["a", "b", "c"]), { a: firstGate, b: 1, c: 1 },
    );
    exec.addTool(block("a"), execCall("a", "ls | wc -l"));
    exec.addTool(block("b"), execCall("b", "cat README.md | wc -l"));
    exec.addTool(block("c"), execCall("c", "cat package.json | wc -l"));
    exec.dispatchPending();
    exec.close();
    const results = collect(exec);
    try {
      await expect.poll(() => timeline).toEqual(["start:a"]);
      // The drain watchdog can cancel one waiting call without cancelling
      // its active predecessor or the other waiting calls.
      const waiting = (exec as unknown as { tools: TrackedTool[] }).tools.find((tool) => tool.id === "b")!;
      waiting.drainCancel!.abort(new Error("isolated tool timeout"));
      await expect.poll(() => waiting.finalized).toBe(true);
      await delay(0);
      expect(timeline).toEqual(["start:a"]);
    } finally {
      releaseFirst();
      await results;
    }
    expect(timeline).toEqual(["start:a", "end:a", "start:c", "end:c"]);
    expect(concurrentDuring.c).toEqual([1, 1]);
    expect((await results).map((result) => result.result.isError === true)).toEqual([false, true, false]);
  });

  test("its path waits for the complete response before it starts", async () => {
    const { exec, timeline } = routedHarness(new Set(["b"]), { a: 5, b: 1 });
    exec.addTool(block("a"), execCall("a", "ls -la"));
    exec.addTool(block("b"), execCall("b", "cat README.md | wc -l"));
    // Still streaming: read-only calls may start, a possibly writing path may not.
    exec.dispatchPending({ safeOnly: true });
    await delay(40);
    expect(timeline).toEqual(["start:a", "end:a"]);
    exec.close();
    expect(await drain(exec)).toEqual(["a", "b"]);
    expect(timeline).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  test("its path never starts after a dropped stream cancelled the queued calls", async () => {
    const { exec, timeline } = routedHarness(new Set(["b"]), { a: 5, b: 1 });
    exec.addTool(block("a"), execCall("a", "ls -la"));
    exec.addTool(block("b"), execCall("b", "cat README.md | wc -l"));
    exec.dispatchPending({ safeOnly: true });
    await delay(40);
    exec.cancelQueued("connection_lost");
    exec.close();
    const results = await collect(exec);
    expect(results.map((result) => result.toolCall.id)).toEqual(["a", "b"]);
    expect(results[0]!.result.isError).not.toBe(true);
    expect(results[1]!.result.isError).toBe(true);
    expect(timeline).toEqual(["start:a", "end:a"]);
  });

  test("an interrupt while it waits to run alone cancels it before its path runs", async () => {
    const interrupt = new AbortController();
    const { exec, timeline } = routedHarness(new Set(["b"]), { a: 5_000, b: 1, c: 1 }, interrupt.signal);
    exec.addTool(block("a"), execCall("a", "ls -la"));
    exec.addTool(block("b"), execCall("b", "cat README.md | wc -l"));
    exec.addTool(block("c"), execCall("c", "touch out.txt"));
    exec.dispatchPending();
    exec.close();
    await delay(20);
    interrupt.abort("interrupt");
    const results = await collect(exec);
    expect(results.map((result) => result.toolCall.id)).toEqual(["a", "b", "c"]);
    expect(results.map((result) => result.result.isError)).toEqual([true, true, true]);
    // b never ran its (possibly writing) path and the later write never started.
    expect(timeline).toEqual(["start:a"]);
  });

  test("an interrupt during side-by-side read-only calls ends each one and starts nothing after them", async () => {
    const interrupt = new AbortController();
    const { exec, timeline } = routedHarness(new Set(), { a: 5_000, b: 5_000, c: 5_000, d: 1 }, interrupt.signal);
    exec.addTool(block("a"), execCall("a", "ls -la"));
    exec.addTool(block("b"), execCall("b", "cat README.md"));
    exec.addTool(block("c"), execCall("c", "wc -l data/orders.csv"));
    exec.addTool(block("d"), execCall("d", "touch out.txt"));
    exec.dispatchPending();
    exec.close();
    await delay(20);
    interrupt.abort("interrupt");
    const results = await collect(exec);
    expect(results.map((result) => result.toolCall.id)).toEqual(["a", "b", "c", "d"]);
    expect(results.map((result) => result.result.isError)).toEqual([true, true, true, true]);
    expect(timeline).toEqual(["start:a", "start:b", "start:c"]);
  });
});
