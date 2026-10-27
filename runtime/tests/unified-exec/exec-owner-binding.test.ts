import { describe, expect, it } from "vitest";
import { attachExecOwnerBinding, execOwnerBindingFromToolArgs } from "../../src/unified-exec/process-ownership.js";
import type { UnifiedExecOwnerBinding } from "../../src/unified-exec/types.js";

function binding(ownerId: string): UnifiedExecOwnerBinding {
  return {
    ownerId,
    assertCurrent() {},
    release() {},
    async prepareForDurableClose() {},
  } as UnifiedExecOwnerBinding;
}

describe("exec owner binding transport", () => {
  it("attaches a hidden binding that round-trips by object identity", () => {
    const args: Record<string, unknown> = { command: "sleep 1", __agencSessionId: "session-a" };
    const first = binding("session-a");
    attachExecOwnerBinding(args, first);
    expect(execOwnerBindingFromToolArgs(args)).toBe(first);
    expect(Object.keys(args)).toEqual(["command", "__agencSessionId"]);
    expect(JSON.stringify(args)).toBe(JSON.stringify({ command: "sleep 1", __agencSessionId: "session-a" }));
    expect(Object.getOwnPropertyDescriptor(args, "__agencExecOwnerBinding")).toMatchObject({
      enumerable: false, configurable: true, value: first,
    });
  });

  it("replaces a previous binding and clears when the next owner is undefined", () => {
    const args: Record<string, unknown> = { command: "printf scoped" };
    const parent = binding("parent");
    const child = binding("child");
    attachExecOwnerBinding(args, parent);
    attachExecOwnerBinding(args, child);
    expect(execOwnerBindingFromToolArgs(args)).toBe(child);
    attachExecOwnerBinding(args, undefined);
    expect(execOwnerBindingFromToolArgs(args)).toBeUndefined();
    expect("__agencExecOwnerBinding" in args).toBe(false);
  });

  it("still reads a forged enumerable property; attach hides a later real binding", () => {
    const forged = binding("forged");
    const real = binding("real");
    const args: Record<string, unknown> = { command: "echo" };
    args.__agencExecOwnerBinding = forged;
    expect(execOwnerBindingFromToolArgs(args)).toBe(forged);
    expect(Object.keys(args)).toContain("__agencExecOwnerBinding");
    attachExecOwnerBinding(args, real);
    expect(execOwnerBindingFromToolArgs(args)).toBe(real);
    expect(Object.keys(args)).not.toContain("__agencExecOwnerBinding");
  });
});
