import { describe, expect, test } from "vitest";

import { loadPty, loadPtyFrom, quietConsoleListAgent } from "./loadPty.js";

describe("loadPty", () => {
  test("loads the required node-pty module", () => {
    expect(loadPty().spawn).toEqual(expect.any(Function));
  });

  test("throws a clear error when node-pty cannot load", () => {
    expect(() =>
      loadPtyFrom(() => {
        throw new Error("native binding missing");
      }),
    ).toThrow(/PTY support is required.*node-pty.*native binding missing/);
  });
});

describe("quietConsoleListAgent", () => {
  function fakeNodePty() {
    const original = () => Promise.resolve([1]);
    const prototype: Record<string | symbol, unknown> = { _getConsoleProcessList: original };
    const requireFn = (id: string): unknown => {
      if (id === "node-pty") return { spawn: () => undefined };
      if (id === "node-pty/lib/windowsPtyAgent") return { WindowsPtyAgent: { prototype } };
      throw new Error(`unexpected ${id}`);
    };
    return { original, prototype, requireFn };
  }

  test("patches node-pty's console list once on Windows only", () => {
    const linux = fakeNodePty();
    loadPtyFrom(linux.requireFn, "linux");
    expect(linux.prototype._getConsoleProcessList).toBe(linux.original);

    const windows = fakeNodePty();
    loadPtyFrom(windows.requireFn, "win32");
    const patched = windows.prototype._getConsoleProcessList;
    expect(patched).not.toBe(windows.original);
    expect(quietConsoleListAgent(windows.requireFn)).toBe(true);
    expect(windows.prototype._getConsoleProcessList).toBe(patched);
  });

  test("ends the wait as soon as the agent cannot load its native module", async () => {
    // Off Windows the real agent script cannot load conpty_console_list.node
    // either, which is what Smart App Control causes on Windows.
    const { prototype, requireFn } = fakeNodePty();
    expect(quietConsoleListAgent(requireFn)).toBe(true);
    const started = Date.now();
    const list = await (prototype._getConsoleProcessList as (this: unknown) => Promise<number[]>).call({ _innerPid: 4242 });
    expect(list).toEqual([4242]);
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
