/**
 * Unit tests for the embedding SDK's subprocess transport
 * (`packages/agenc-sdk/src/subprocess.ts`) with a fake `agenc -p` child:
 * no daemon, no real spawn. The fake replays the CLI's
 * `--output-format stream-json` contract (`{type:"event"}` lines followed
 * by one `{type:"result"}` line) exactly as `runtime/src/bin/agenc.ts`
 * emits it.
 */

import { EventEmitter, getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import {
  promptViaSubprocess,
  type AgencPromptEvent,
  type AgencSubprocessChild,
  type AgencSubprocessSpawnFn,
} from "../../../packages/agenc-sdk/src/index";

interface FakeChildScript {
  readonly stdoutLines: readonly unknown[];
  readonly exitCode: number;
  readonly stderr?: string;
}

interface SpawnCapture {
  command: string;
  args: readonly string[];
  stdinChunks: string[];
  stdinEnded: boolean;
}

function createFakeSpawn(script: FakeChildScript): {
  readonly spawn: AgencSubprocessSpawnFn;
  readonly capture: SpawnCapture;
} {
  const capture: SpawnCapture = {
    command: "",
    args: [],
    stdinChunks: [],
    stdinEnded: false,
  };
  const spawn: AgencSubprocessSpawnFn = (command, args) => {
    capture.command = command;
    capture.args = args;
    const emitter = new EventEmitter();
    const stdout = new EventEmitter() as EventEmitter & {
      setEncoding: (encoding: string) => void;
    };
    stdout.setEncoding = () => {};
    const stderr = new EventEmitter() as EventEmitter & {
      setEncoding: (encoding: string) => void;
    };
    stderr.setEncoding = () => {};
    const child: AgencSubprocessChild = {
      stdin: {
        write: (chunk: string) => {
          capture.stdinChunks.push(chunk);
          return true;
        },
        on: () => {},
        end: () => {
          capture.stdinEnded = true;
          // Replay the scripted run asynchronously, split mid-line to prove
          // the line reassembly works.
          setImmediate(() => {
            const payload = script.stdoutLines
              .map((line) => `${JSON.stringify(line)}\n`)
              .join("");
            const middle = Math.floor(payload.length / 2);
            stdout.emit("data", payload.slice(0, middle));
            stdout.emit("data", payload.slice(middle));
            if (script.stderr !== undefined) {
              stderr.emit("data", script.stderr);
            }
            emitter.emit("exit", script.exitCode, null);
          });
        },
      },
      stdout: stdout as unknown as AgencSubprocessChild["stdout"],
      stderr: stderr as unknown as AgencSubprocessChild["stderr"],
      once: (event: string, listener: (...args: never[]) => void) => {
        emitter.once(event, listener as (...args: unknown[]) => void);
        return child;
      },
      kill: () => {
        emitter.emit("exit", null, "SIGTERM");
        return true;
      },
    };
    return child;
  };
  return { spawn, capture };
}

const sessionId = "session_sub_1";
const agentId = "agent_sub_1";

function eventLine(event: unknown): unknown {
  return { type: "event", sessionId, agentId, event };
}

describe("agenc-sdk subprocess transport", () => {
  it("spawns the headless CLI with the stream-json contract and adapts events", async () => {
    const { spawn, capture } = createFakeSpawn({
      stdoutLines: [
        eventLine({
          jsonrpc: "2.0",
          method: "event.message_chunk",
          params: { sessionId, eventId: "e1", delta: "The answer " },
        }),
        eventLine({
          jsonrpc: "2.0",
          method: "event.tool_request",
          params: {
            sessionId,
            eventId: "e2",
            requestId: "tool_1",
            toolName: "Grep",
          },
        }),
        eventLine({
          jsonrpc: "2.0",
          method: "event.message_chunk",
          params: { sessionId, eventId: "e3", delta: "is 42" },
        }),
        {
          type: "result",
          sessionId,
          agentId,
          exitCode: 0,
          finalMessage: "The answer is 42",
          deniedPermissionRequestIds: [],
          tokenUsage: {
            inputTokens: 5,
            outputTokens: 3,
            totalTokens: 8,
            costUsd: 0.001,
          },
          cacheStats: { requestCount: 1 },
        },
      ],
      exitCode: 0,
    });

    const run = promptViaSubprocess("what is the answer?", {
      agencCommand: ["/opt/agenc/bin/agenc"],
      model: "grok-4",
      spawn,
    });
    const events: AgencPromptEvent[] = [];
    for await (const event of run) {
      events.push(event);
    }
    const result = await run.result();

    expect(capture.command).toBe("/opt/agenc/bin/agenc");
    expect(capture.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--model",
      "grok-4",
    ]);
    expect(capture.stdinEnded).toBe(true);
    expect(capture.stdinChunks.join("")).toBe(
      `${JSON.stringify({ type: "prompt", prompt: "what is the answer?" })}\n`,
    );

    expect(
      events
        .filter(
          (event): event is Extract<AgencPromptEvent, { type: "text" }> =>
            event.type === "text",
        )
        .map((event) => event.delta)
        .join(""),
    ).toBe("The answer is 42");
    expect(events.some((event) => event.type === "tool_call")).toBe(true);

    expect(result).toMatchObject({
      stopReason: "completed",
      exitCode: 0,
      finalMessage: "The answer is 42",
      deniedPermissionRequestIds: [],
      usage: { totalTokens: 8 },
      cacheStats: { requestCount: 1 },
    });
  });

  it("maps the CLI's tool-denied exit code (2) to an errored result", async () => {
    const { spawn } = createFakeSpawn({
      stdoutLines: [
        eventLine({
          jsonrpc: "2.0",
          method: "event.permission_request",
          params: {
            sessionId,
            eventId: "e1",
            requestId: "perm_1",
            toolName: "Bash",
            permissions: ["bash"],
          },
        }),
        {
          type: "result",
          sessionId,
          agentId,
          exitCode: 2,
          finalMessage: "gave up",
          deniedPermissionRequestIds: ["perm_1"],
        },
      ],
      exitCode: 2,
    });

    const run = promptViaSubprocess("do something", { spawn });
    const events: AgencPromptEvent[] = [];
    let returned: unknown;
    const iterator = run[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        returned = next.value;
        break;
      }
      events.push(next.value);
    }

    expect(
      events.find((event) => event.type === "permission_request"),
    ).toMatchObject({ requestId: "perm_1" });
    expect(returned).toMatchObject({
      stopReason: "errored",
      exitCode: 2,
      finalMessage: "gave up",
      deniedPermissionRequestIds: ["perm_1"],
    });
    await expect(run.result()).resolves.toMatchObject({ exitCode: 2 });
  });

  it("rejects when the CLI exits without a stream-json result", async () => {
    const { spawn } = createFakeSpawn({
      stdoutLines: [],
      exitCode: 1,
      stderr: "agenc: no prompt provided",
    });

    const run = promptViaSubprocess("hello", { spawn });
    await expect(run.result()).rejects.toThrow(
      /exited \(code 1\).*no prompt provided/s,
    );
    await expect(
      (async () => {
        for await (const event of run) {
          void event;
        }
      })(),
    ).rejects.toThrow(/exited \(code 1\)/);
  });

  // M-TUI-8: a child that exits before draining stdin breaks the pipe; without an
  // "error" listener on child.stdin, Node throws the EPIPE as an uncaught
  // exception in the embedder's process (child.once("error") only covers spawn
  // errors, not stream errors). Here the fake stdin is a real EventEmitter, so
  // emitting "error" with no listener throws exactly as a real Writable would.
  it("routes a broken stdin pipe (EPIPE) into result() rejection instead of crashing", async () => {
    const spawn: AgencSubprocessSpawnFn = () => {
      const emitter = new EventEmitter();
      const stdin = new EventEmitter() as EventEmitter & {
        write: (chunk: string) => unknown;
        end: () => unknown;
      };
      stdin.write = () => {
        stdin.emit(
          "error",
          Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
        );
        return false;
      };
      stdin.end = () => undefined;
      const stdout = new EventEmitter() as EventEmitter & {
        setEncoding: (encoding: string) => void;
      };
      stdout.setEncoding = () => {};
      const stderr = new EventEmitter() as EventEmitter & {
        setEncoding: (encoding: string) => void;
      };
      stderr.setEncoding = () => {};
      const child: AgencSubprocessChild = {
        stdin: stdin as unknown as AgencSubprocessChild["stdin"],
        stdout: stdout as unknown as AgencSubprocessChild["stdout"],
        stderr: stderr as unknown as AgencSubprocessChild["stderr"],
        once: (event: string, listener: (...args: never[]) => void) => {
          emitter.once(event, listener as (...args: unknown[]) => void);
          return child;
        },
        kill: () => true,
      };
      return child;
    };

    let run: ReturnType<typeof promptViaSubprocess> | undefined;
    // Without the fix, the synchronous EPIPE with no listener throws right here,
    // out of promptViaSubprocess — so constructing the run must not throw.
    expect(() => {
      run = promptViaSubprocess("hello", { spawn });
    }).not.toThrow();
    await expect(run!.result()).rejects.toThrow(/stdin write failed/i);
  });

  it("removes the abort listener from a reused signal once the run completes", async () => {
    const controller = new AbortController();
    const { spawn } = createFakeSpawn({
      stdoutLines: [
        {
          type: "result",
          sessionId,
          agentId,
          exitCode: 0,
          finalMessage: "ok",
          deniedPermissionRequestIds: [],
        },
      ],
      exitCode: 0,
    });

    const run = promptViaSubprocess("hi", {
      spawn,
      signal: controller.signal,
    });
    // Registered while the run is in flight...
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    await run.result();
    // ...and removed on completion, so a long-lived signal reused across many
    // runs does not accumulate one dead listener per run.
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("caps the internal event buffer at 1000 when events are not consumed", async () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 1500; i += 1) {
      lines.push(
        eventLine({
          jsonrpc: "2.0",
          method: "event.message_chunk",
          params: { sessionId, eventId: `e${i}`, delta: `d${i} ` },
        }),
      );
    }
    lines.push({
      type: "result",
      sessionId,
      agentId,
      exitCode: 0,
      finalMessage: "done",
      deniedPermissionRequestIds: [],
    });
    const { spawn } = createFakeSpawn({ stdoutLines: lines, exitCode: 0 });

    // Await result() first so all 1500 events accumulate before any consumption.
    const run = promptViaSubprocess("go", { spawn });
    await run.result();

    const drained: AgencPromptEvent[] = [];
    for await (const event of run) {
      drained.push(event);
    }
    // Uncapped this would be 1500; the cap holds only the most recent 1000.
    expect(drained.length).toBeGreaterThan(0);
    expect(drained.length).toBeLessThanOrEqual(1000);
  });
});
