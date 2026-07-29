import { PassThrough } from "node:stream";

import { decodeMulti, encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";

import {
  NeovimRpcError,
  NeovimRpcRequestAbortedError,
  NeovimRpcRequestTimeoutError,
  NeovimRpcTransport,
} from "../../../src/tui/workbench/buffer/neovim/NeovimRpc.js";

function createTransport(): {
  readonly rpc: NeovimRpcTransport;
  readonly childStdout: PassThrough;
  readonly childStdin: PassThrough;
  readonly writtenMessages: () => readonly any[];
} {
  const childStdout = new PassThrough();
  const childStdin = new PassThrough();
  const written: Buffer[] = [];
  childStdin.on("data", (chunk: Buffer) => {
    written.push(chunk);
  });
  const rpc = new NeovimRpcTransport(childStdout, childStdin);
  rpc.start();
  return {
    rpc,
    childStdout,
    childStdin,
    writtenMessages: () => [...decodeMulti(Buffer.concat(written))],
  };
}

describe("embedded Neovim msgpack RPC transport", () => {
  it("encodes requests and resolves matching responses by id", async () => {
    const { rpc, childStdout, writtenMessages } = createTransport();
    const first = rpc.request("nvim_get_current_buf");
    const second = rpc.request("nvim_get_mode");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writtenMessages()).toEqual([
      [0, 1, "nvim_get_current_buf", []],
      [0, 2, "nvim_get_mode", []],
    ]);

    childStdout.write(encode([1, 2, null, { mode: "n" }]));
    childStdout.write(encode([1, 1, null, 7]));

    await expect(first).resolves.toBe(7);
    await expect(second).resolves.toEqual({ mode: "n" });
  });

  it("rejects a request when Neovim returns an RPC error", async () => {
    const { rpc, childStdout } = createTransport();
    const request = rpc.request("nvim_command", ["write"]);

    childStdout.write(encode([1, 1, ["E32", "No file name"], null]));

    await expect(request).rejects.toBeInstanceOf(NeovimRpcError);
    await expect(request).rejects.toThrow("nvim_command#1");
  });

  it("decodes a msgpack response split across stdout chunks", async () => {
    const { rpc, childStdout } = createTransport();
    const request = rpc.request("nvim_eval", ["1"]);
    const frame = Buffer.from(encode([1, 1, null, 42]));

    childStdout.write(frame.subarray(0, 2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    childStdout.write(frame.subarray(2));

    await expect(request).resolves.toBe(42);
  });

  it("dispatches registered notifications and records unhandled notifications", async () => {
    const { rpc, childStdout } = createTransport();
    const seen: string[] = [];
    const firstUnsubscribe = rpc.onNotification("redraw", (params) => {
      seen.push(String(params[0]));
    });
    rpc.onNotification("redraw", (params) => {
      seen.push(`second:${String(params[0])}`);
    });
    firstUnsubscribe();

    childStdout.write(encode([2, "redraw", ["grid"]]));
    childStdout.write(encode([2, "other_event", [1]]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual(["second:grid"]);
    expect(rpc.getUnhandledNotifications()).toEqual([{ method: "other_event", params: [1] }]);
  });

  it("dispatches notifications while a pending request still resolves by id", async () => {
    const { rpc, childStdout } = createTransport();
    const seen: string[] = [];
    rpc.onNotification("redraw", (params) => {
      seen.push(String(params[0]));
    });
    const request = rpc.request("nvim_get_mode");

    childStdout.write(encode([2, "redraw", ["grid"]]));
    childStdout.write(encode([1, 1, null, "ok"]));

    await expect(request).resolves.toBe("ok");
    expect(seen).toEqual(["grid"]);
  });

  it("rejects pending requests when the transport closes", async () => {
    const { rpc, writtenMessages } = createTransport();
    const request = rpc.request("nvim_command", ["write"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const writesBeforeClose = writtenMessages().length;

    rpc.close("test close");

    await expect(request).rejects.toThrow("test close");
    await expect(rpc.request("nvim_eval", ["1"])).rejects.toThrow("closed");
    expect(writtenMessages()).toHaveLength(writesBeforeClose);
  });

  it("rejects pending requests when stdout ends cleanly", async () => {
    const { rpc, childStdout } = createTransport();
    const request = rpc.request("nvim_command", ["write"]);

    childStdout.end();

    await expect(request).rejects.toThrow("output ended");
  });

  it("times out one request, cleans its pending state, and ignores its late response", async () => {
    const { rpc, childStdout, writtenMessages } = createTransport();
    const errors: string[] = [];
    rpc.onError((error) => errors.push(error.message));

    const timedOut = rpc.request(
      "nvim_slow_request",
      [],
      { timeoutMs: 15 },
    );
    await expect(timedOut).rejects.toMatchObject({
      name: "NeovimRpcRequestTimeoutError",
      method: "nvim_slow_request",
      requestId: 1,
      timeoutMs: 15,
    });
    await expect(timedOut).rejects.toBeInstanceOf(NeovimRpcRequestTimeoutError);

    childStdout.write(encode([1, 1, null, "too late"]));
    const next = rpc.request("nvim_get_mode");
    childStdout.write(encode([1, 2, null, { mode: "n" }]));
    await expect(next).resolves.toEqual({ mode: "n" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writtenMessages()).toEqual([
      [0, 1, "nvim_slow_request", []],
      [0, 2, "nvim_get_mode", []],
    ]);
    expect(errors).not.toContain(
      "Neovim RPC response arrived for inactive request id 1.",
    );
  });

  it("aborts one request without writing when already aborted and cleans abort listeners", async () => {
    const { rpc, childStdout, writtenMessages } = createTransport();
    const errors: string[] = [];
    rpc.onError((error) => errors.push(error.message));
    const controller = new AbortController();
    const aborted = rpc.request(
      "nvim_wait",
      [],
      { signal: controller.signal },
    );
    controller.abort(new Error("x".repeat(10_000)));

    await expect(aborted).rejects.toBeInstanceOf(NeovimRpcRequestAbortedError);
    await expect(aborted).rejects.toMatchObject({
      method: "nvim_wait",
      requestId: 1,
    });
    childStdout.write(encode([1, 1, null, "too late"]));

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      rpc.request("nvim_never_written", [], { signal: alreadyAborted.signal }),
    ).rejects.toBeInstanceOf(NeovimRpcRequestAbortedError);

    const completed = rpc.request(
      "nvim_completed",
      [],
      { signal: controller.signal },
    );
    await expect(completed).rejects.toBeInstanceOf(NeovimRpcRequestAbortedError);

    const freshController = new AbortController();
    const successful = rpc.request(
      "nvim_successful",
      [],
      { signal: freshController.signal, timeoutMs: 1_000 },
    );
    childStdout.write(encode([1, 4, null, true]));
    await expect(successful).resolves.toBe(true);
    freshController.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writtenMessages()).toEqual([
      [0, 1, "nvim_wait", []],
      [0, 4, "nvim_successful", []],
    ]);
    expect(errors).not.toContain(
      "Neovim RPC response arrived for inactive request id 1.",
    );
  });

  it("validates request deadlines before allocating or writing a request", async () => {
    const { rpc, childStdout, writtenMessages } = createTransport();

    await expect(
      rpc.request("invalid_zero", [], { timeoutMs: 0 }),
    ).rejects.toThrow("finite and positive");
    await expect(
      rpc.request("invalid_infinity", [], { timeoutMs: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("finite and positive");

    const valid = rpc.request("valid", [], { timeoutMs: 1_000 });
    childStdout.write(encode([1, 1, null, true]));
    await expect(valid).resolves.toBe(true);
    expect(writtenMessages()).toEqual([[0, 1, "valid", []]]);
  });

  it("answers registered inbound requests and enforces one handler owner", async () => {
    const { rpc, childStdout, writtenMessages } = createTransport();
    const seen: unknown[] = [];
    const handler = async (
      params: readonly unknown[],
      context: { readonly method: string; readonly requestId: number },
    ) => {
      seen.push({ params, context });
      return { allowed: true, token: "reviewed" } as const;
    };
    const unregister = rpc.onRequest("agenc_before_write", handler as any);

    expect(() => rpc.onRequest("agenc_before_write", () => null)).toThrow(
      "already registered",
    );
    childStdout.write(
      encode([0, 41, "agenc_before_write", ["/workspace/file.ts"]]),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual([
      {
        params: ["/workspace/file.ts"],
        context: expect.objectContaining({
          method: "agenc_before_write",
          requestId: 41,
          signal: expect.any(AbortSignal),
        }),
      },
    ]);
    expect(writtenMessages()).toEqual([
      [1, 41, null, { allowed: true, token: "reviewed" }],
    ]);

    unregister();
    expect(() => rpc.onRequest("agenc_before_write", () => null)).not.toThrow();
  });

  it("returns bounded RPC errors for unknown and failed inbound requests", async () => {
    const { rpc, childStdout, writtenMessages } = createTransport();
    const errors: string[] = [];
    rpc.onError((error) => errors.push(error.message));
    rpc.onRequest("agenc_guard_failure", () => {
      throw new Error("sensitive".repeat(1_000));
    });

    childStdout.write(encode([0, 51, "not_registered", []]));
    childStdout.write(encode([0, 52, "agenc_guard_failure", []]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const messages = writtenMessages() as Array<
      [number, number, { code: string; message: string } | null, unknown]
    >;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual([
      1,
      51,
      expect.objectContaining({ code: "method_not_registered" }),
      null,
    ]);
    expect(messages[1]).toEqual([
      1,
      52,
      expect.objectContaining({ code: "handler_failed" }),
      null,
    ]);
    expect(messages[1]![2]!.message.length).toBeLessThanOrEqual(512);
    expect(errors).toContain(
      "Unexpected Neovim RPC request from child: not_registered",
    );
    expect(errors.some((message) => message.includes("agenc_guard_failure"))).toBe(true);
    expect(errors.every((message) => message.length < 1_024)).toBe(true);
  });

  it("aborts active inbound handlers when the transport closes", async () => {
    const { rpc, childStdout, writtenMessages } = createTransport();
    let handlerSignal: AbortSignal | undefined;
    let observeAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    rpc.onRequest("agenc_hold", async (_params, context) => {
      handlerSignal = context.signal;
      await new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => {
          observeAbort();
          resolve();
        }, { once: true });
      });
      return null;
    });

    childStdout.write(encode([0, 61, "agenc_hold", []]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    rpc.close("test close");
    await aborted;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handlerSignal?.aborted).toBe(true);
    expect(writtenMessages()).toEqual([]);
  });

  it("sends notifications, unregisters handlers, and reports handler failures", async () => {
    const { rpc, childStdout, writtenMessages } = createTransport();
    const errors: string[] = [];
    const unsubscribeError = rpc.onError((error) => errors.push(error.message));
    const unsubscribeRedraw = rpc.onNotification("redraw", () => {
      throw new Error("redraw failed");
    });
    const unsubscribeStringFailure = rpc.onNotification("string_failure", () => {
      throw "string redraw failed";
    });

    rpc.notify("nvim_set_client_info", ["agenc"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writtenMessages()).toEqual([
      [2, "nvim_set_client_info", ["agenc"]],
    ]);

    childStdout.write(encode([2, "redraw", []]));
    childStdout.write(encode([2, "string_failure", []]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual(["redraw failed", "string redraw failed"]);

    unsubscribeRedraw();
    unsubscribeStringFailure();
    unsubscribeError();
    childStdout.write(encode([2, "redraw", ["after"]]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rpc.getUnhandledNotifications()).toContainEqual({ method: "redraw", params: ["after"] });

    rpc.close();
    rpc.notify("nvim_command", ["write"]);
    expect(writtenMessages()).toHaveLength(1);
  });

  it("surfaces malformed frames and inactive responses through transport errors", async () => {
    const { rpc, childStdout } = createTransport();
    const errors: string[] = [];
    rpc.onError((error) => errors.push(error.message));

    childStdout.write(encode([1, 99, null, true]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toContain("Neovim RPC response arrived for inactive request id 99.");

    const pending = rpc.request("nvim_eval", ["1"]);
    childStdout.write(encode(["bad"]));
    await expect(pending).rejects.toThrow("Malformed Neovim RPC frame");
    expect(errors.some((message) => message.includes("Malformed Neovim RPC frame"))).toBe(true);
  });

  it("reports unexpected child requests and malformed typed frames", async () => {
    const { rpc, childStdout } = createTransport();
    const errors: string[] = [];
    rpc.onError((error) => errors.push(error.message));

    childStdout.write(encode([0, 1, "nvim_call_function", []]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toContain("Unexpected Neovim RPC request from child: nvim_call_function");

    const pending = rpc.request("nvim_eval", ["1"]);
    childStdout.write(encode([2, "redraw", "bad params"]));
    await expect(pending).rejects.toThrow("Malformed Neovim RPC frame");
  });

  it("rejects when request writes fail before bytes reach the child", async () => {
    const childStdout = new PassThrough();
    const childStdin = {
      on() {
        return this;
      },
      write(_bytes: Buffer, callback: (error?: Error | null) => void) {
        callback(new Error("write failed"));
        return false;
      },
    };
    const rpc = new NeovimRpcTransport(childStdout, childStdin as any);
    const errors: string[] = [];
    rpc.onError((error) => errors.push(error.message));

    await expect(rpc.request("nvim_command", ["write"])).rejects.toThrow("write failed");
    expect(errors.some((message) => message.includes("write failed"))).toBe(true);
  });

  it("reports notification write failures without a pending request", async () => {
    const childStdout = new PassThrough();
    const childStdin = {
      on() {
        return this;
      },
      write(_bytes: Buffer, callback: (error?: Error | null) => void) {
        callback(new Error("notify write failed"));
        return false;
      },
    };
    const rpc = new NeovimRpcTransport(childStdout, childStdin as any);
    const errors: string[] = [];
    rpc.onError((error) => errors.push(error.message));

    rpc.notify("nvim_command", ["write"]);

    expect(errors.some((message) => message.includes("notify write failed"))).toBe(true);
  });

  it("rejects and reports synchronous encode failures", async () => {
    const childStdout = new PassThrough();
    const childStdin = new PassThrough();
    const rpc = new NeovimRpcTransport(childStdout, childStdin);
    const errors: string[] = [];
    rpc.onError((error) => errors.push(error.message));
    const recursiveValue: Record<string, any> = {};
    recursiveValue.self = recursiveValue;

    await expect(rpc.request("nvim_bad", [recursiveValue])).rejects.toThrow();
    expect(errors.length).toBe(1);

    rpc.notify("nvim_bad_notify", [recursiveValue]);
    expect(errors.length).toBe(2);
  });

  it("owns stdin stream errors after the child exits so EPIPE cannot crash the TUI", async () => {
    const childStdout = new PassThrough();
    const childStdin = new PassThrough();
    const rpc = new NeovimRpcTransport(childStdout, childStdin);
    const errors: string[] = [];
    rpc.onError((error) => errors.push(error.message));
    const pending = rpc.request("nvim_command", ["quit!"]);

    childStdin.emit("error", new Error("write EPIPE"));

    await expect(pending).rejects.toThrow("write EPIPE");
    expect(errors).toEqual(["write EPIPE"]);
    await expect(rpc.request("nvim_eval", ["1"])).rejects.toThrow("closed");
  });

  it("normalizes non-Error stdin stream failures", async () => {
    const childStdout = new PassThrough();
    const childStdin = new PassThrough();
    const rpc = new NeovimRpcTransport(childStdout, childStdin);
    const errors: string[] = [];
    rpc.onError((error) => errors.push(error.message));

    childStdin.emit("error", "string stream failure");

    expect(errors).toEqual(["string stream failure"]);
    await expect(rpc.request("nvim_eval", ["1"])).rejects.toThrow("closed");
  });

  it("normalizes non-Error read loop failures", async () => {
    const output = {
      async *[Symbol.asyncIterator]() {
        throw "decode string failure";
      },
    };
    const rpc = new NeovimRpcTransport(output as any, new PassThrough());
    const errors: string[] = [];
    rpc.onError((error) => errors.push(error.message));

    rpc.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toEqual(["decode string failure"]);
    await expect(rpc.request("nvim_eval", ["1"])).rejects.toThrow("closed");
  });

  it("formats byte and object RPC errors with request context", () => {
    expect(new NeovimRpcError("null", 6, null).message).toContain("null");
    expect(new NeovimRpcError("bytes", 7, new Uint8Array([1, 2])).message).toContain("<2 bytes>");
    expect(new NeovimRpcError("number", 9, 42).message).toContain("42");
    expect(new NeovimRpcError("object", 8, { code: "E" }).message).toContain("{\"code\":\"E\"}");
    const recursiveValue: Record<string, any> = {};
    recursiveValue.self = recursiveValue;
    expect(new NeovimRpcError("recursive", 10, recursiveValue).message).toContain("[object Object]");
  });
});
