/**
 * Unit tests for the embedding SDK's subprocess transport
 * (`packages/agenc-sdk/src/subprocess.ts`) with a fake `agenc -p` child:
 * no daemon, no real spawn. The fake replays the CLI's
 * `--output-format stream-json` contract (`{type:"event"}` lines followed
 * by one `{type:"result"}` line) exactly as `runtime/src/bin/agenc-main.ts`
 * emits it.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_BUFFERED_PROMPT_EVENTS,
  promptViaSubprocess,
  signalOwnedDetachedProcessGroup,
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
        removeListener: () => {},
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
            stdout.emit("end");
            emitter.emit("close", script.exitCode, null);
          });
        },
      },
      stdout: stdout as unknown as AgencSubprocessChild["stdout"],
      stderr: stderr as unknown as AgencSubprocessChild["stderr"],
      once: (event: string, listener: (...args: never[]) => void) => {
        emitter.once(event, listener as (...args: unknown[]) => void);
        return child;
      },
      on: (event: string, listener: (...args: never[]) => void) => {
        emitter.on(event, listener as (...args: unknown[]) => void);
        return child;
      },
      removeListener: (event: string, listener: (...args: never[]) => void) => {
        emitter.removeListener(
          event,
          listener as (...args: unknown[]) => void,
        );
        return child;
      },
      kill: () => {
        emitter.emit("exit", null, "SIGTERM");
        stdout.emit("end");
        emitter.emit("close", null, "SIGTERM");
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
    stdin: {
      write: () => true,
      on: () => {},
      removeListener: () => {},
      end: () => {},
    },
    stdout: stdout as unknown as AgencSubprocessChild["stdout"],
    stderr: stderr as unknown as AgencSubprocessChild["stderr"],
    once: (event: string, listener: (...args: never[]) => void) => {
      emitter.once(event, listener as (...args: unknown[]) => void);
      return child;
    },
    on: (event: string, listener: (...args: never[]) => void) => {
      emitter.on(event, listener as (...args: unknown[]) => void);
      return child;
    },
    removeListener: (event: string, listener: (...args: never[]) => void) => {
      emitter.removeListener(event, listener as (...args: unknown[]) => void);
      return child;
    },
    kill: () => {
      emitter.emit("exit", null, "SIGTERM");
      stdout.emit("end");
      emitter.emit("close", null, "SIGTERM");
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
      stdout.emit("end");
      emitter.emit("close", code, null);
    },
  };
}

const sessionId = "session_sub_1";
const agentId = "agent_sub_1";

function eventLine(event: unknown): unknown {
  return { type: "event", sessionId, agentId, event };
}

function streamResult(finalMessage: string, exitCode = 0): unknown {
  return {
    type: "result",
    sessionId,
    agentId,
    exitCode,
    finalMessage,
    deniedPermissionRequestIds: [],
  };
}

interface ControllableChild {
  readonly pid: number;
  readonly kills: string[];
  emitExit(code: number | null, signal?: string | null): void;
  emitClose(code: number | null, signal?: string | null): void;
  emitSpawnError(error: Error): void;
  writeStdout(chunk: string): void;
  endStdout(): void;
  writeStderr(chunk: string): void;
  listenerCounts(): {
    child: { error: number; exit: number; close: number };
    stdout: { data: number; end: number };
    stderr: { data: number };
    stdin: { error: number };
  };
}

function createControllableSpawn(): {
  readonly spawn: AgencSubprocessSpawnFn;
  readonly child: () => ControllableChild;
} {
  let handle: ControllableChild | undefined;
  const spawn: AgencSubprocessSpawnFn = () => {
    const processEmitter = new EventEmitter();
    const stdout = new EventEmitter() as EventEmitter & {
      setEncoding: (encoding: string) => void;
    };
    stdout.setEncoding = () => {};
    const stderr = new EventEmitter() as EventEmitter & {
      setEncoding: (encoding: string) => void;
    };
    stderr.setEncoding = () => {};
    const stdin = new EventEmitter();
    const kills: string[] = [];
    const child = {
      pid: 4242,
      stdin: {
        write: () => true,
        end: () => undefined,
        on: (event: "error", listener: (error: Error) => void) => {
          stdin.on(event, listener);
          return child.stdin;
        },
        removeListener: (event: "error", listener: (error: Error) => void) => {
          stdin.removeListener(event, listener);
          return child.stdin;
        },
      },
      stdout: stdout as unknown as AgencSubprocessChild["stdout"],
      stderr: stderr as unknown as AgencSubprocessChild["stderr"],
      once: (event: string, listener: (...args: never[]) => void) => {
        processEmitter.once(event, listener as (...args: unknown[]) => void);
        return child;
      },
      on: (event: string, listener: (...args: never[]) => void) => {
        processEmitter.on(event, listener as (...args: unknown[]) => void);
        return child;
      },
      removeListener: (event: string, listener: (...args: never[]) => void) => {
        processEmitter.removeListener(
          event,
          listener as (...args: unknown[]) => void,
        );
        return child;
      },
      kill: (signal?: string) => {
        kills.push(signal ?? "SIGTERM");
        return true;
      },
    } as unknown as AgencSubprocessChild;
    handle = {
      pid: 4242,
      kills,
      emitExit: (code, signal = null) => {
        processEmitter.emit("exit", code, signal);
      },
      emitClose: (code, signal = null) => {
        processEmitter.emit("close", code, signal);
      },
      emitSpawnError: (error) => {
        processEmitter.emit("error", error);
      },
      writeStdout: (chunk) => {
        stdout.emit("data", chunk);
      },
      endStdout: () => {
        stdout.emit("end");
      },
      writeStderr: (chunk) => {
        stderr.emit("data", chunk);
      },
      listenerCounts: () => ({
        child: {
          error: processEmitter.listenerCount("error"),
          exit: processEmitter.listenerCount("exit"),
          close: processEmitter.listenerCount("close"),
        },
        stdout: {
          data: stdout.listenerCount("data"),
          end: stdout.listenerCount("end"),
        },
        stderr: { data: stderr.listenerCount("data") },
        stdin: { error: stdin.listenerCount("error") },
      }),
    };
    return child;
  };
  return {
    spawn,
    child: () => {
      if (handle === undefined) {
        throw new Error("spawn has not been called");
      }
      return handle;
    },
  };
}

function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function pollUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function reapProcess(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}

/**
 * Default-spawner argv: node runs a wrapper that leaves a descendant holding
 * inherited stdout, writes that pid, then exits with no stream-json result.
 * `signalPath` makes the descendant record SIGTERM before it exits.
 */
function detachedHolderCommand(
  pidPath: string,
  signalPath?: string,
): readonly [string, string] {
  const readyPath = `${pidPath}.ready`;
  const onTerm =
    signalPath === undefined
      ? ""
      : `process.on("SIGTERM",()=>{require("node:fs").writeFileSync(${JSON.stringify(signalPath)},"SIGTERM");process.exit(0);});`;
  const descendant = `${onTerm}require("node:fs").writeFileSync(${JSON.stringify(readyPath)},"1");setInterval(()=>{},1000);`;
  const wrapper = [
    'const {spawn}=require("node:child_process");const fs=require("node:fs");',
    `const child=spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:["ignore","inherit","inherit"]});`,
    "child.unref();",
    `const ready=${JSON.stringify(readyPath)};const deadline=Date.now()+2000;`,
    "while(!fs.existsSync(ready)){if(Date.now()>deadline)process.exit(1);",
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}",
    `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));process.exit(0);`,
  ].join("");
  const scriptPath = `${pidPath}.wrapper.cjs`;
  writeFileSync(scriptPath, wrapper);
  return [process.execPath, scriptPath];
}

function spawnLateResultWrapper(): AgencSubprocessSpawnFn {
  return (_command, _args, options) => {
    const result = JSON.stringify(streamResult("late-pipe"));
    const descendant = `setTimeout(() => { process.stdout.write(${JSON.stringify(`${result}\n`)}); }, 40);`;
    const wrapper = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.unref();
      process.exit(0);
    `;
    return nodeSpawn(process.execPath, ["-e", wrapper], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as unknown as AgencSubprocessChild;
  };
}

describe("signalOwnedDetachedProcessGroup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signals only a detached group whose pid is a safe integer above 1 and not this process", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(signalOwnedDetachedProcessGroup(1, "SIGKILL", true)).toBe(false);
    expect(signalOwnedDetachedProcessGroup(0, "SIGKILL", true)).toBe(false);
    expect(signalOwnedDetachedProcessGroup(-4242, "SIGKILL", true)).toBe(false);
    expect(signalOwnedDetachedProcessGroup(1.5, "SIGKILL", true)).toBe(false);
    expect(
      signalOwnedDetachedProcessGroup(Number.MAX_SAFE_INTEGER + 1, "SIGKILL", true),
    ).toBe(false);
    expect(signalOwnedDetachedProcessGroup(process.pid, "SIGKILL", true)).toBe(
      false,
    );
    expect(signalOwnedDetachedProcessGroup(4242, "SIGKILL", false)).toBe(false);
    expect(signalOwnedDetachedProcessGroup(undefined, "SIGTERM", true)).toBe(
      false,
    );
    if (process.platform === "win32") {
      expect(signalOwnedDetachedProcessGroup(4242, "SIGKILL", true)).toBe(false);
      expect(kill).not.toHaveBeenCalled();
      return;
    }
    expect(signalOwnedDetachedProcessGroup(4242, "SIGKILL", true)).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
  });

  it("returns false when the group signal fails", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(signalOwnedDetachedProcessGroup(4242, "SIGTERM", true)).toBe(false);
  });
});

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
        on: (event: string, listener: (...args: never[]) => void) => {
          emitter.on(event, listener as (...args: unknown[]) => void);
          return child;
        },
        removeListener: (
          event: string,
          listener: (...args: never[]) => void,
        ) => {
          emitter.removeListener(
            event,
            listener as (...args: unknown[]) => void,
          );
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

  it("resolves a valid result delivered after exit but before close", async () => {
    const { spawn, child } = createControllableSpawn();
    const run = promptViaSubprocess("late result", { spawn });
    const pending = run.result();

    child().emitExit(0, null);
    await Promise.resolve();
    child().writeStdout(`${JSON.stringify(streamResult("after-exit"))}\n`);
    child().endStdout();
    child().emitClose(0, null);

    await expect(pending).resolves.toMatchObject({
      exitCode: 0,
      finalMessage: "after-exit",
      stopReason: "completed",
    });
  });

  it("parses the final unterminated stream-json line once after stdout ends", async () => {
    const { spawn, child } = createControllableSpawn();
    const run = promptViaSubprocess("partial line", { spawn });

    child().writeStdout(JSON.stringify(streamResult("unterminated")));
    child().endStdout();
    child().writeStdout(`${JSON.stringify(streamResult("should-be-ignored"))}\n`);
    child().emitExit(0, null);
    child().emitClose(0, null);

    await expect(run.result()).resolves.toMatchObject({
      exitCode: 0,
      finalMessage: "unterminated",
    });
  });

  it("still rejects with the missing stream-json result error when the child closes empty", async () => {
    const { spawn, child } = createControllableSpawn();
    const run = promptViaSubprocess("hello", { spawn });

    child().writeStderr("agenc: no prompt provided");
    child().emitExit(1, null);
    child().endStdout();
    child().emitClose(1, null);

    await expect(run.result()).rejects.toThrow(
      /exited \(code 1\).*no prompt provided/s,
    );
  });

  it("settles abort and spawn-error races once and removes every listener", async () => {
    const abort = new AbortController();
    const { spawn, child } = createControllableSpawn();
    const run = promptViaSubprocess("race", {
      spawn,
      signal: abort.signal,
    });
    const first = run.result();
    const second = run.result();

    abort.abort();
    child().emitSpawnError(new Error("spawn ENOENT"));
    child().emitExit(null, "SIGTERM");
    child().endStdout();
    child().emitClose(null, "SIGTERM");

    await expect(first).rejects.toThrow(/failed to spawn AgenC CLI|exited/);
    await expect(second).rejects.toBe(await first.catch((error: unknown) => error));
    expect(child().listenerCounts()).toEqual({
      child: { error: 0, exit: 0, close: 0 },
      stdout: { data: 0, end: 0 },
      stderr: { data: 0 },
      stdin: { error: 0 },
    });
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });

  it("times out a post-exit drain with a distinct error and kills retained descendants", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const { spawn, child } = createControllableSpawn();
      const run = promptViaSubprocess("hung stdout", {
        spawn,
        detachProcessGroup: true,
        postExitDrainTimeoutMs: 30,
      });

      child().emitExit(0, null);
      await expect(run.result()).rejects.toThrow(
        /exited \(code 0\).*did not close within 30ms/s,
      );
      expect(child().kills).toContain("SIGKILL");
      expect(kill).not.toHaveBeenCalled();
      expect(child().listenerCounts()).toEqual({
        child: { error: 0, exit: 0, close: 0 },
        stdout: { data: 0, end: 0 },
        stderr: { data: 0 },
        stdin: { error: 0 },
      });
    } finally {
      kill.mockRestore();
    }
  });

  describe("owned detached process group", () => {
    const descendants: number[] = [];

    afterEach(() => {
      for (const pid of descendants.splice(0)) reapProcess(pid);
    });

    async function readLiveDescendantPid(pidPath: string): Promise<number> {
      expect(await pollUntil(() => existsSync(pidPath), 2_000)).toBe(true);
      const pid = Number(readFileSync(pidPath, "utf8"));
      expect(pid).toBeGreaterThan(1);
      expect(pid).not.toBe(process.pid);
      descendants.push(pid);
      expect(await pollUntil(() => isLiveProcess(pid), 1_000)).toBe(true);
      return pid;
    }

    it.skipIf(process.platform === "win32")(
      "SIGKILLs a detached descendant that keeps stdout open after the wrapper exits",
      async () => {
        const root = mkdtempSync(join(tmpdir(), "agenc-sdk-drain-group-"));
        const pidPath = join(root, "descendant.pid");
        try {
          const run = promptViaSubprocess("held stdout", {
            agencCommand: detachedHolderCommand(pidPath),
            detachProcessGroup: true,
            postExitDrainTimeoutMs: 80,
          });
          const pending = run.result();
          const pid = await readLiveDescendantPid(pidPath);

          await expect(pending).rejects.toThrow(/did not close within 80ms/);
          expect(await pollUntil(() => !isLiveProcess(pid), 2_000)).toBe(true);
          expect(isLiveProcess(process.pid)).toBe(true);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it.skipIf(process.platform === "win32")(
      "forwards SIGTERM to a detached descendant on cancel",
      async () => {
        const root = mkdtempSync(join(tmpdir(), "agenc-sdk-cancel-group-"));
        const pidPath = join(root, "descendant.pid");
        const signalPath = join(root, "signal");
        try {
          const run = promptViaSubprocess("cancel group", {
            agencCommand: detachedHolderCommand(pidPath, signalPath),
            detachProcessGroup: true,
            postExitDrainTimeoutMs: 2_000,
          });
          const pending = run.result();
          const pid = await readLiveDescendantPid(pidPath);

          run.cancel();
          await expect(pending).rejects.toThrow(/without a stream-json result/);
          expect(await pollUntil(() => existsSync(signalPath), 2_000)).toBe(true);
          expect(readFileSync(signalPath, "utf8")).toBe("SIGTERM");
          expect(await pollUntil(() => !isLiveProcess(pid), 2_000)).toBe(true);
          expect(isLiveProcess(process.pid)).toBe(true);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
  });

  it("accepts a real wrapper that exits before an inherited-stdout descendant writes the result", async () => {
    const run = promptViaSubprocess("real late pipe", {
      spawn: spawnLateResultWrapper(),
    });
    await expect(run.result()).resolves.toMatchObject({
      exitCode: 0,
      finalMessage: "late-pipe",
    });
  });
});
