import { PassThrough } from "node:stream";

import { decodeMulti, encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";

import {
  NeovimRpcError,
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
