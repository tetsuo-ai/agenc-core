import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import { isDaemonCausalRoutineMessage } from "./overload.js";
import { holdAgentLifecycleLock } from "./held-agent-lifecycle-lock.js";
import { assertAliasControlDispatch, blockedControlHandler } from "./transport-contract-helpers.js";
import {
  AGENC_STDIO_DEFAULT_MAX_LINE_BYTES,
  AgenCStdioTransport,
  encodeBoundedJsonLine,
  encodeJsonLine,
  parseJsonObjectLine,
  writeJsonLine,
} from "./transport/stdio.js";

function nextChunk(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    stream.once("data", (chunk: Buffer) => {
      resolve(chunk.toString("utf8"));
    });
  });
}

const RESPONSIVE_CONTROL_METHODS = [
  "agent.create",
  "run.cancel",
  "session.cancelTurn",
  "agent.list",
  "session.list",
  "session.snapshot",
  "session.hooks.status",
  "health.ping",
  "health.ready",
  "health.stats",
] as const;

describe("AgenC stdio transport", () => {
  it("keeps a routine write on another connection behind that connection's FIFO head", async () => {
    const turnInput = new PassThrough();
    const turnOutput = new PassThrough();
    let releaseTurn!: () => void;
    let turnStarted!: () => void;
    const turnDone = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const turnEntered = new Promise<void>((resolve) => { turnStarted = resolve; });
    const turnTransport = new AgenCStdioTransport({ input: turnInput, output: turnOutput,
      onMessage: async () => { turnStarted(); await turnDone; },
    });
    turnTransport.start();
    const input = new PassThrough();
    const output = new PassThrough();
    const events: string[] = [];
    let releaseHead!: () => void;
    let headStarted!: () => void;
    const headDone = new Promise<void>((resolve) => { releaseHead = resolve; });
    const started = new Promise<void>((resolve) => { headStarted = resolve; });
    const transport = new AgenCStdioTransport({ input, output, onMessage: async (message) => {
      events.push(String(message.method));
      if (message.method === "routine.get") {
        headStarted();
        await headDone;
      }
    } });
    transport.start();
    try {
      turnInput.write('{"jsonrpc":"2.0","id":1,"method":"message.stream","params":{"sessionId":"session-on-other-connection"}}\n');
      await turnEntered;
      input.write('{"jsonrpc":"2.0","id":1,"method":"routine.get"}\n');
      await started;
      input.write(JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id: 2, method: "routine.update", params: {
        permissionAuthority: { kind: "session", sessionId: "session-on-other-connection", toolCallId: "running-call" },
      } }) + "\n");
      input.write('{"jsonrpc":"2.0","id":3,"method":"routine.delete"}\n');
      await delay(20);
      expect(events).toEqual(["routine.get"]);
      releaseHead();
      await vi.waitFor(() => expect(events).toEqual(["routine.get", "routine.update", "routine.delete"]));
    } finally { releaseHead(); releaseTurn(); await transport.close(); await turnTransport.close(); }
  });

  it("serializes a tool's bypassed updates and its later delete", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const events: string[] = [];
    let releaseTurn!: () => void;
    let releaseFirstUpdate!: () => void;
    let turnStarted!: () => void;
    let firstUpdateStarted!: () => void;
    const turnDone = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const firstUpdateDone = new Promise<void>((resolve) => { releaseFirstUpdate = resolve; });
    const turnEntered = new Promise<void>((resolve) => { turnStarted = resolve; });
    const firstUpdateEntered = new Promise<void>((resolve) => { firstUpdateStarted = resolve; });
    const transport = new AgenCStdioTransport({ input, output, onMessage: async (message) => {
      if (message.method === "message.stream") {
        events.push("turn:start"); turnStarted(); await turnDone; events.push("turn:end");
      } else if (message.id === 2) {
        events.push("first:start"); firstUpdateStarted(); await firstUpdateDone; events.push("first:end");
      } else {
        events.push(String(message.method));
      }
    } });
    transport.start();
    const update = (id: number) => JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id,
      method: "routine.update", params: { permissionAuthority: {
        kind: "session", sessionId: "s", toolCallId: "call",
      } },
    }) + "\n";
    try {
      input.write('{"jsonrpc":"2.0","id":1,"method":"message.stream","params":{"sessionId":"s"}}\n');
      await turnEntered;
      input.write(update(2));
      await firstUpdateEntered;
      input.write(update(3));
      input.write('{"jsonrpc":"2.0","id":4,"method":"routine.delete"}\n');
      await delay(20);
      expect(events).toEqual(["turn:start", "first:start"]);
      releaseFirstUpdate();
      await vi.waitFor(() => expect(events).toContain("routine.update"));
      releaseTurn();
      await vi.waitFor(() => expect(events).toEqual([
        "turn:start", "first:start", "first:end", "routine.update", "turn:end", "routine.delete",
      ]));
    } finally { releaseFirstUpdate(); releaseTurn(); await transport.close(); }
  });

  // Desktop runs turns with message.send; both methods stream a session's turn.
  it.each(["message.stream", "message.send"])("resolves an aliased %s head before placing later requests", async (turnMethod) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const seen: string[] = [];
    let releaseTurn!: () => void;
    let turnStarted!: () => void;
    const turnDone = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const entered = new Promise<void>((resolve) => { turnStarted = resolve; });
    const transport = new AgenCStdioTransport({
      input, output,
      resolveRoutineSessionId: (id) =>
        id === "agent-a" || id === "session-a" ? "session-a" : undefined,
      onMessage: async (message) => {
        seen.push(String(message.id));
        if (message.id === 1) { turnStarted(); await turnDone; }
      },
    });
    transport.start();
    const send = (id: number, method: string, params: object) => input.write(JSON.stringify({
      jsonrpc: JSON_RPC_VERSION, id, method, params,
    }) + "\n");
    try {
      send(1, turnMethod, { sessionId: "agent-a" });
      await entered;
      send(2, "routine.create", { permissionAuthority: { kind: "session", sessionId: "session-a", toolCallId: "call" } });
      send(3, "routine.get", {});
      await vi.waitFor(() => expect(seen).toEqual(["1", "2"]));
      releaseTurn();
      await vi.waitFor(() => expect(seen).toEqual(["1", "2", "3"]));
    } finally { releaseTurn(); await transport.close(); }
  });

  it("dispatches an alias write, controls and priority work while the scheduling state lock is held", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const seen: string[] = [];
    let releaseTurn!: () => void;
    let turnStarted!: () => void;
    const turnDone = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const enteredTurn = new Promise<void>((resolve) => { turnStarted = resolve; });
    let heldLock: Awaited<ReturnType<typeof holdAgentLifecycleLock>> | undefined;
    const transport = new AgenCStdioTransport({
      input, output,
      resolveRoutineSessionId: (id) => heldLock?.manager.peekRoutineSessionId(id),
      onMessage: async (message) => {
        seen.push(String(message.method));
        if (message.method === "message.stream") { turnStarted(); await turnDone; }
      },
    });
    transport.start();
    const send = (id: number, method: string, params: object = {}) => input.write(JSON.stringify({
      jsonrpc: JSON_RPC_VERSION, id, method, params,
    }) + "\n");
    try {
      await assertAliasControlDispatch(send, enteredTurn, seen, (lock) => { heldLock = lock; });
    } finally { await heldLock?.release(); releaseTurn(); await transport.close(); }
  });

  it.each(["message.stream", "message.send"])("answers a tool call's routine.create during a blocked %s turn while ordinary work stays queued", async (turnMethod) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const events: string[] = [];
    const responses: number[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) responses.push(JSON.parse(line).id as number);
    });
    let releaseTurn!: () => void;
    let turnStarted!: () => void;
    const started = new Promise<void>((resolve) => { turnStarted = resolve; });
    const turnFinished = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let transport!: AgenCStdioTransport;
    transport = new AgenCStdioTransport({
      input, output,
      onMessage: async (message) => {
        events.push(`${message.method}:start`);
        if (message.method === turnMethod) {
          turnStarted();
          await turnFinished;
        }
        await transport.send({ jsonrpc: JSON_RPC_VERSION, id: message.id!, result: {} });
        events.push(`${message.method}:end`);
      },
    });
    transport.start();
    try {
      input.write(`{"jsonrpc":"2.0","id":1,"method":"${turnMethod}","params":{"sessionId":"s"}}\n`);
      await started;
      input.write('{"jsonrpc":"2.0","id":2,"method":"routine.create","params":{"permissionAuthority":{"kind":"session","sessionId":"s","toolCallId":"call"}}}\n');
      input.write('{"jsonrpc":"2.0","id":3,"method":"session.clear"}\n');
      input.write('{"jsonrpc":"2.0","id":4,"method":"routine.get"}\n');
      await vi.waitFor(() => expect(responses).toEqual([2]), { timeout: 2_000 });
      expect(events).toEqual([`${turnMethod}:start`, "routine.create:start", "routine.create:end"]);
      releaseTurn();
      await vi.waitFor(() => expect(responses).toEqual([2, 1, 3, 4]), { timeout: 2_000 });
    } finally {
      releaseTurn();
      await transport.close();
    }
  });
  it("encodes one compact JSON message per newline", () => {
    const line = encodeJsonLine({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      result: { text: "hello\nworld" },
    });

    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      result: { text: "hello\nworld" },
    });
  });

  it("bounds the real escaped workspace sync JSON-RPC frame", () => {
    const requestFor = (content: string, workspaceRoot = "/workspace") => ({
      jsonrpc: JSON_RPC_VERSION,
      id: Number.MAX_SAFE_INTEGER,
      method: "workspace.editor.sync",
      params: {
        workspaceRoot,
        editorInstanceId: "editor-boundary",
        leaseToken: "lease-boundary",
        epoch: 1,
        sequence: 1,
        buffers: [
          {
            path: "/workspace/control-bytes.ts",
            bufferHandle: 1,
            changedtick: 1,
            contentSha256: "a".repeat(64),
            contentBytes: content.length,
            dirty: true,
            content,
          },
        ],
      },
    });
    // Leave a few MiB for one-byte path padding so the valid frame can land
    // on the byte boundary exactly while still exercising JSON escaping.
    const escapedContent = "\0".repeat(2 * 1024 * 1024);
    const minimallyRootedFrameBytes = Buffer.byteLength(
      JSON.stringify(requestFor(escapedContent, "/")),
      "utf8",
    );
    const workspaceRoot = `/${"x".repeat(
      AGENC_STDIO_DEFAULT_MAX_LINE_BYTES - minimallyRootedFrameBytes,
    )}`;
    const boundaryLine = encodeBoundedJsonLine(
      requestFor(escapedContent, workspaceRoot),
    );

    expect(Buffer.byteLength(boundaryLine, "utf8") - 1).toBe(
      AGENC_STDIO_DEFAULT_MAX_LINE_BYTES,
    );
    expect(() =>
      encodeBoundedJsonLine(requestFor(`${escapedContent}\0`, workspaceRoot)),
    ).toThrow(/exceeding the 16777216-byte limit/u);
  });

  it("parses JSON object lines and rejects malformed frames", () => {
    expect(
      parseJsonObjectLine(
        '{"jsonrpc":"2.0","id":1,"method":"agent.list","params":{}}',
      ),
    ).toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      method: "agent.list",
      params: {},
    });

    expect(() => parseJsonObjectLine("")).toThrow(/empty JSON line/);
    expect(() => parseJsonObjectLine("[]")).toThrow(/expected a JSON object/);
    expect(() => parseJsonObjectLine("{")).toThrow(SyntaxError);
  });

  it("reads newline-delimited requests from input and writes responses to output", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received = new Promise((resolve) => {
      const transport = new AgenCStdioTransport({
        input,
        output,
        onMessage: resolve,
      });
      transport.start();
    });

    input.write(
      '{"jsonrpc":"2.0","id":7,"method":"message.send","params":{"sessionId":"session_1","content":"hello"}}\n',
    );

    await expect(received).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 7,
      method: "message.send",
      params: { sessionId: "session_1", content: "hello" },
    });

    await writeJsonLine(output, {
      jsonrpc: JSON_RPC_VERSION,
      id: 7,
      result: { messageId: "message_1", acceptedAt: "now" },
    });

    await expect(nextChunk(output)).resolves.toBe(
      '{"jsonrpc":"2.0","id":7,"result":{"messageId":"message_1","acceptedAt":"now"}}\n',
    );
  });

  it("reports bad input lines without stopping subsequent valid messages", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: readonly Error[] = [];
    const received = new Promise((resolve) => {
      const transport = new AgenCStdioTransport({
        input,
        output,
        onMessage: resolve,
        onError: (error) => {
          (errors as Error[]).push(error);
        },
      });
      transport.start();
    });

    input.write("not-json\n");
    input.write('{"jsonrpc":"2.0","id":2,"method":"auth.whoami"}\n');

    await expect(received).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 2,
      method: "auth.whoami",
    });
    expect(errors).toHaveLength(1);
  });

  it("dispatches two pipelined same-connection requests in arrival order", async () => {
    // Regression for audit #13: dispatch used to be fire-and-forget
    // (`Promise.resolve(onMessage(...))` not awaited), so a slow first
    // handler let the second request's handler complete first, corrupting
    // order-dependent flows (e.g. session.clear then message.send).
    const input = new PassThrough();
    const output = new PassThrough();
    const completionOrder: number[] = [];
    let resolveFirst: (() => void) | undefined;
    const transport = new AgenCStdioTransport({
      input,
      output,
      onMessage: async (message) => {
        const id = message.id as number;
        if (id === 1) {
          // First handler is slow; it must still complete before the
          // second handler is even invoked, because dispatch is serialized.
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        completionOrder.push(id);
      },
    });
    transport.start();

    input.write('{"jsonrpc":"2.0","id":1,"method":"session.clear"}\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"message.send"}\n');

    // Give the event loop time: without serialization the second handler
    // would have already run and pushed `2` before `1`.
    await delay(20);
    expect(completionOrder).toEqual([]);

    resolveFirst?.();
    await delay(20);
    expect(completionOrder).toEqual([1, 2]);

    await transport.close();
  });

  it("does not let attach overtake a pipelined create dependency", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const events: string[] = [];
    let releaseCreate: (() => void) | undefined;
    const transport = new AgenCStdioTransport({
      input,
      output,
      onMessage: async (message) => {
        if (message.method === "agent.create") {
          events.push("create:start");
          await new Promise<void>((resolve) => {
            releaseCreate = resolve;
          });
          events.push("create:end");
          return;
        }
        events.push(String(message.method));
      },
    });
    transport.start();

    input.write('{"jsonrpc":"2.0","id":1,"method":"agent.create"}\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"agent.attach"}\n');
    await delay(20);
    expect(events).toEqual(["create:start"]);

    releaseCreate?.();
    await delay(20);
    expect(events).toEqual(["create:start", "create:end", "agent.attach"]);
    await transport.close();
  });

  it.each(["health.ping", "routine.create"])("does not let %s overtake connection initialization", async (method) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const events: string[] = [];
    let releaseInitialize: (() => void) | undefined;
    const transport = new AgenCStdioTransport({
      input,
      output,
      onMessage: async (message) => {
        if (message.method === "initialize") {
          events.push("initialize:start");
          await new Promise<void>((resolve) => {
            releaseInitialize = resolve;
          });
          events.push("initialize:end");
          return;
        }
        events.push(String(message.method));
      },
    });
    transport.start();

    input.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1.0.0"}}\n',
    );
    const following = { jsonrpc: "2.0", id: 2, method,
      ...(method === "routine.create" ? { params: { permissionAuthority: {
        kind: "session", sessionId: "s", toolCallId: "call",
      } } } : {}),
    };
    if (method === "routine.create") expect(isDaemonCausalRoutineMessage(following)).toBe(true);
    input.write(JSON.stringify(following) + "\n");
    await delay(20);
    expect(events).toEqual(["initialize:start"]);

    releaseInitialize?.();
    await delay(20);
    expect(events).toEqual([
      "initialize:start",
      "initialize:end",
      method,
    ]);
    await transport.close();
  });

  it("dispatches request.cancel ahead of an in-flight long request", async () => {
    // Regression for the transport-FIFO cancellation starvation: a
    // request.cancel chained behind a long-running request could never run
    // until that request completed, defeating cancellation. Control messages
    // must dispatch off-chain so cancel runs while the target is still in
    // flight, while normal requests stay FIFO (guarded by the test above).
    const input = new PassThrough();
    const output = new PassThrough();
    const { events, longStarted, releaseLong, onMessage } = blockedControlHandler(
      "session.partialCompactFromMessage", "long", "request.cancel", "cancel",
    );

    const transport = new AgenCStdioTransport({
      input,
      output,
      onMessage,
    });
    transport.start();

    input.write(
      '{"jsonrpc":"2.0","id":1,"method":"session.partialCompactFromMessage"}\n',
    );
    await longStarted;
    input.write('{"jsonrpc":"2.0","id":2,"method":"request.cancel"}\n');

    await delay(20);
    // Cancel must have run while the long request is still blocked.
    expect(events).toEqual(["long:start", "cancel"]);

    releaseLong?.();
    await delay(20);
    expect(events).toEqual(["long:start", "cancel", "long:end"]);

    await transport.close();
  });

  it("dispatches session.cancelTurn ahead of an in-flight stream request", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const { events, longStarted, releaseLong, onMessage } = blockedControlHandler(
      "message.stream", "stream", "session.cancelTurn", "turn:cancel",
    );

    const transport = new AgenCStdioTransport({
      input,
      output,
      onMessage,
    });
    transport.start();

    input.write('{"jsonrpc":"2.0","id":1,"method":"message.stream"}\n');
    await longStarted;
    input.write(
      '{"jsonrpc":"2.0","id":2,"method":"session.cancelTurn","params":{"sessionId":"session_1","reason":"interrupted"}}\n',
    );

    await delay(20);
    expect(events).toEqual(["stream:start", "turn:cancel"]);

    releaseLong?.();
    await delay(20);
    expect(events).toEqual(["stream:start", "turn:cancel", "stream:end"]);

    await transport.close();
  });

  it("keeps cancel, health, status, and session lookup responsive under a blocked stream", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const events: string[] = [];
    let releaseStream: (() => void) | undefined;
    let resolveStarted: () => void = () => {};
    const streamStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const transport = new AgenCStdioTransport({
      input,
      output,
      onMessage: async (message) => {
        if (message.method === "message.stream") {
          events.push("stream:start");
          resolveStarted();
          await new Promise<void>((resolve) => {
            releaseStream = resolve;
          });
          events.push("stream:end");
          return;
        }
        events.push(String(message.method));
      },
    });
    transport.start();

    input.write(
      `${JSON.stringify({
        jsonrpc: JSON_RPC_VERSION,
        id: "stream",
        method: "message.stream",
      })}\n`,
    );
    await streamStarted;
    for (const [index, method] of RESPONSIVE_CONTROL_METHODS.entries()) {
      input.write(
        `${JSON.stringify({
          jsonrpc: JSON_RPC_VERSION,
          id: `control-${index}`,
          method,
        })}\n`,
      );
    }

    await delay(40);
    expect(events[0]).toBe("stream:start");
    expect(events).not.toContain("stream:end");
    expect(events.slice(1).sort()).toEqual(
      [...RESPONSIVE_CONTROL_METHODS].sort(),
    );

    releaseStream?.();
    await delay(20);
    expect(events.at(-1)).toBe("stream:end");
    await transport.close();
  });

  it.each(["tool.approve", "tool.deny", "elicitation.respond"])(
    "dispatches %s ahead of the in-flight message it must unblock",
    async (decisionMethod) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const events: string[] = [];
      let releaseMessage: (() => void) | undefined;
      let resolveStarted: () => void = () => {};
      const messageStarted = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      const transport = new AgenCStdioTransport({
        input,
        output,
        onMessage: async (message) => {
          if (message.method === "message.send") {
            events.push("message:start");
            resolveStarted();
            await new Promise<void>((resolve) => {
              releaseMessage = resolve;
            });
            events.push("message:end");
          } else if (message.method === decisionMethod) {
            events.push(decisionMethod);
          }
        },
      });
      transport.start();

      input.write('{"jsonrpc":"2.0","id":1,"method":"message.send"}\n');
      await messageStarted;
      input.write(
        `${JSON.stringify({
          jsonrpc: JSON_RPC_VERSION,
          id: 2,
          method: decisionMethod,
        })}\n`,
      );

      await delay(20);
      const eventsWhileMessageBlocked = [...events];
      releaseMessage?.();
      await delay(20);

      expect(eventsWhileMessageBlocked).toEqual([
        "message:start",
        decisionMethod,
      ]);
      expect(events).toEqual(["message:start", decisionMethod, "message:end"]);

      await transport.close();
    },
  );

  it("rejects normal requests beyond the per-connection queue cap", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let releaseFirst: (() => void) | undefined;
    let resolveStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const transport = new AgenCStdioTransport({
      input,
      output,
      maxQueuedRequests: 1,
      onMessage: async (message) => {
        if (message.id === 1) {
          resolveStarted();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      },
    });
    transport.start();

    input.write('{"jsonrpc":"2.0","id":1,"method":"session.clear"}\n');
    await firstStarted;
    input.write('{"jsonrpc":"2.0","id":2,"method":"message.send"}\n');

    const rejected = JSON.parse(await nextChunk(output));
    expect(rejected).toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: 2,
      error: {
        code: -32000,
        data: {
          code: "TOO_MANY_QUEUED_REQUESTS",
          maxQueuedRequests: 1,
        },
      },
    });

    releaseFirst?.();
    await transport.close();
  });

  it("tears down the connection when an unterminated line exceeds the cap", async () => {
    // Regression for audit #14: readline imposes no max line length, so a
    // peer streaming bytes without a newline grew daemon memory unbounded.
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: Error[] = [];
    const destroyed = new Promise<void>((resolve) => {
      input.once("close", () => resolve());
    });
    const transport = new AgenCStdioTransport({
      input,
      output,
      maxLineBytes: 64,
      onMessage: () => {},
      onError: (error) => {
        errors.push(error);
      },
    });
    transport.start();

    // 200 bytes with no newline must trip the 64-byte bound.
    input.write("x".repeat(200));

    await destroyed;
    expect(input.destroyed).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RangeError);
    expect(errors[0]?.message).toMatch(/line exceeded 64 bytes/);
  });

  it("does not trip the cap when newlines keep lines bounded", async () => {
    // Prior valid behavior: a long stream of newline-terminated frames whose
    // individual lines stay under the cap must keep flowing.
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: Error[] = [];
    const received: number[] = [];
    const transport = new AgenCStdioTransport({
      input,
      output,
      maxLineBytes: 64,
      onMessage: (message) => {
        received.push(message.id as number);
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    transport.start();

    for (let id = 1; id <= 10; id += 1) {
      input.write(`{"jsonrpc":"2.0","id":${id},"method":"ping"}\n`);
    }

    await delay(20);
    expect(errors).toHaveLength(0);
    expect(input.destroyed).toBe(false);
    expect(received).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    await transport.close();
  });

  it("exposes a default max line bound matching the websocket payload cap", () => {
    expect(AGENC_STDIO_DEFAULT_MAX_LINE_BYTES).toBe(16 * 1024 * 1024);
  });

  it("can send through the transport instance", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new AgenCStdioTransport({
      input,
      output,
      onMessage: () => {},
    });

    await transport.send({
      jsonrpc: JSON_RPC_VERSION,
      id: 3,
      result: { authenticated: false },
    });

    await expect(nextChunk(output)).resolves.toBe(
      '{"jsonrpc":"2.0","id":3,"result":{"authenticated":false}}\n',
    );
  });
});
