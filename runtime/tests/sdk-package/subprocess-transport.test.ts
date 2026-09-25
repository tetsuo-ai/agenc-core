/**
 * Unit tests for the embedding SDK's subprocess transport
 * (`packages/agenc-sdk/src/subprocess.ts`) with a fake `agenc -p` child:
 * no daemon, no real spawn. The fake replays the CLI's
 * `--output-format stream-json` contract (`{type:"event"}` lines followed
 * by one `{type:"result"}` line) exactly as `runtime/src/bin/agenc-main.ts`
 * emits it.
 */

import { EventEmitter, getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import {
  MAX_BUFFERED_PROMPT_EVENTS,
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

/**
 * A fake child whose stdout the test drives line by line, so a consumer can be
 * made to stall between deliveries.
 */
function createManualChild(): {
  readonly spawn: AgencSubprocessSpawnFn;
  emitLine(line: unknown): void;
  exit(code: number): void;
} {
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
    stdin: { write: () => true, on: () => {}, end: () => {} },
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
  return {
    spawn: () => child,
    emitLine: (line) => {
      stdout.emit("data", `${JSON.stringify(line)}\n`);
    },
    exit: (code) => {
      emitter.emit("exit", code, null);
    },
  };
}

const sessionId = "session_sub_1";
const agentId = "agent_sub_1";

function eventLine(event: unknown): unknown {
  return { type: "event", sessionId, agentId, event };
}

describe("agenc-sdk subprocess transport", () => {
  it("uses the combined dangerous flag only when explicitly requested", async () => {
    const { spawn, capture } = createFakeSpawn({
      stdoutLines: [
        {
          type: "result",
          sessionId,
          agentId,
          exitCode: 0,
          finalMessage: "done",
          deniedPermissionRequestIds: [],
        },
      ],
      exitCode: 0,
    });

    const run = promptViaSubprocess("do it", {
      spawn,
      permissionMode: "default",
      dangerouslyBypassApprovalsAndSandbox: true,
    });
    expect(capture.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(capture.args).toContain("--permission-mode");
    await expect(run.result()).resolves.toMatchObject({ exitCode: 0 });
  });

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
        },
      ],
      exitCode: 0,
    });

    const run = promptViaSubprocess("what is the answer?", {
      agencCommand: ["/opt/agenc/bin/agenc"],
      model: "grok-4",
      configPath: "/workspace/operator.toml",
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
      "--config",
      "/workspace/operator.toml",
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

  describe("bounded event buffer (#2090)", () => {
    const chunk = (sequence: number): unknown =>
      eventLine({
        jsonrpc: "2.0",
        method: "event.message_chunk",
        params: { sessionId, eventId: `e${sequence}`, sequence, delta: `d${sequence} ` },
      });
    const resultLine = {
      type: "result",
      sessionId,
      agentId,
      exitCode: 0,
      finalMessage: "done",
      deniedPermissionRequestIds: [],
    };
    const gaps = (events: readonly AgencPromptEvent[]) =>
      events.filter((event) => event.type === "gap");

    it("delivers every event in order with no marker at exactly the cap", async () => {
      const lines: unknown[] = [];
      for (let i = 1; i <= MAX_BUFFERED_PROMPT_EVENTS; i += 1) lines.push(chunk(i));
      lines.push(resultLine);
      const { spawn } = createFakeSpawn({ stdoutLines: lines, exitCode: 0 });

      const run = promptViaSubprocess("go", { spawn });
      await run.result();
      const drained: AgencPromptEvent[] = [];
      for await (const event of run) drained.push(event);

      expect(gaps(drained)).toEqual([]);
      expect(drained.map((event) => event.eventId)).toEqual(
        Array.from({ length: MAX_BUFFERED_PROMPT_EVENTS }, (_, i) => `e${i + 1}`),
      );
    });

    it("surfaces a non-evictable local-overflow gap to a result-first consumer", async () => {
      const total = 1_500;
      const lines: unknown[] = [];
      for (let i = 1; i <= total; i += 1) lines.push(chunk(i));
      lines.push(resultLine);
      const { spawn } = createFakeSpawn({ stdoutLines: lines, exitCode: 0 });

      // Await result() first so all 1,500 events accumulate before any consumption.
      const run = promptViaSubprocess("go", { spawn });
      await expect(run.result()).resolves.toMatchObject({ exitCode: 0 });

      const drained: AgencPromptEvent[] = [];
      for await (const event of run) drained.push(event);

      // A 1,500-event run must never look like a complete 1,000-event stream.
      expect(drained).toHaveLength(MAX_BUFFERED_PROMPT_EVENTS + 1);
      expect(drained[0]).toEqual({
        type: "gap",
        kind: "event_gap",
        reason: "local_overflow",
        sessionId,
        firstAvailableSequence: total - MAX_BUFFERED_PROMPT_EVENTS + 1,
        retiredCount: total - MAX_BUFFERED_PROMPT_EVENTS,
      });
      expect(drained[1]).toMatchObject({ type: "text", eventId: "e501" });
      expect(drained.at(-1)).toMatchObject({ type: "text", eventId: `e${total}` });
      expect(gaps(drained)).toHaveLength(1);
    });

    it("keeps memory bounded and the loss exact when the consumer never drains during the run", async () => {
      const total = 20_000;
      const lines: unknown[] = [];
      for (let i = 1; i <= total; i += 1) lines.push(chunk(i));
      lines.push(resultLine);
      const { spawn } = createFakeSpawn({ stdoutLines: lines, exitCode: 0 });

      const run = promptViaSubprocess("go", { spawn });
      await run.result();

      // Draining after the fact proves the run retained at most the cap plus
      // one marker, and that the marker survived 19,000 further evictions.
      const drained: AgencPromptEvent[] = [];
      for await (const event of run) drained.push(event);
      expect(drained).toHaveLength(MAX_BUFFERED_PROMPT_EVENTS + 1);
      expect(drained[0]).toMatchObject({
        type: "gap",
        reason: "local_overflow",
        retiredCount: total - MAX_BUFFERED_PROMPT_EVENTS,
      });
    });

    it("places the gap where a slow consumer actually lost events", async () => {
      const child = createManualChild();
      const run = promptViaSubprocess("go", { spawn: child.spawn });
      const iterator = run[Symbol.asyncIterator]();

      for (let i = 1; i <= 10; i += 1) child.emitLine(chunk(i));
      const consumedFirst: AgencPromptEvent[] = [];
      for (let i = 0; i < 3; i += 1) consumedFirst.push((await iterator.next()).value as AgencPromptEvent);
      expect(consumedFirst.map((event) => event.eventId)).toEqual(["e1", "e2", "e3"]);

      // 7 buffered; 1,200 more overflow the cap by 207 while the consumer stalls.
      for (let i = 11; i <= 1_210; i += 1) child.emitLine(chunk(i));
      child.emitLine(resultLine);
      child.exit(0);
      await run.result();

      const rest: AgencPromptEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        rest.push(next.value);
      }
      expect(rest[0]).toEqual({
        type: "gap",
        kind: "event_gap",
        reason: "local_overflow",
        sessionId,
        afterSequence: 3,
        firstAvailableSequence: 211,
        retiredCount: 207,
      });
      expect(rest[1]).toMatchObject({ eventId: "e211" });
      expect(rest.at(-1)).toMatchObject({ eventId: "e1210" });
      expect(rest).toHaveLength(MAX_BUFFERED_PROMPT_EVENTS + 1);
    });
  });
});
