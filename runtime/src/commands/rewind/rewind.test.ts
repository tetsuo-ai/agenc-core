// @ts-nocheck
import { describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

const { call } = await import("./rewind.js");
const rewindCommand = (await import("./index.js")).default;

describe("rewind command spec", () => {
  it("declares name + aliases + type", () => {
    expect(rewindCommand.name).toBe("rewind");
    expect(rewindCommand.type).toBe("local");
    expect(rewindCommand.aliases).toContain("checkpoint");
    expect(rewindCommand.supportsNonInteractive).toBe(false);
  });
});

describe("rewind call()", () => {
  it("invokes openMessageSelector on the context when present", async () => {
    const openMessageSelector = vi.fn();
    const ctx = { openMessageSelector } as never;
    const result = await call("", ctx);
    expect(openMessageSelector).toHaveBeenCalledTimes(1);
    expect(result.type).toBe("skip");
  });

  it("does not throw when openMessageSelector is missing", async () => {
    const result = await call("", {} as never);
    expect(result.type).toBe("skip");
  });
});
