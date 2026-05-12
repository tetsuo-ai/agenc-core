import { describe, expect, test } from "vitest";

import { loadPty, loadPtyFrom } from "./loadPty.js";

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
