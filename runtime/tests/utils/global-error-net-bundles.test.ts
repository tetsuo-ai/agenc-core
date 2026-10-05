import { expect, it, vi } from "vitest";

it("uses one process error net across independent module instances", async () => {
  const callbacks = new Map<string, Array<(...args: unknown[]) => void>>();
  const proc = { on(name: string, callback: (...args: unknown[]) => void) {
    callbacks.set(name, [...callbacks.get(name) ?? [], callback]); return this;
  } };
  const first = await import("../../src/utils/global-error-net.js");
  first.installGlobalErrorNet(proc as never);
  vi.resetModules();
  const second = await import("../../src/utils/global-error-net.js");
  expect(first.installGlobalErrorNet).not.toBe(second.installGlobalErrorNet);
  second.installGlobalErrorNet(proc as never);
  expect(callbacks.get("uncaughtException")).toHaveLength(1);
  expect(callbacks.get("unhandledRejection")).toHaveLength(1);
  expect(() => callbacks.get("uncaughtException")![0]!(new Error("bounded test error"))).not.toThrow();
  expect(() => callbacks.get("unhandledRejection")![0]!(new Error("bounded test rejection"))).not.toThrow();
});
