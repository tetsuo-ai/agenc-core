import { expect, it, vi } from "vitest";
import { prepareAdmittedExecutionOperation, withAdmittedExecutionCall } from "../../src/execution/call-context.js";

const identity = { runId: "run", callId: "call", attempt: 3 };

it("keeps concurrent and nested operations under their original admitted call", async () => {
  const signal = new AbortController().signal;
  const crossEffectBoundary = vi.fn();
  await withAdmittedExecutionCall(identity, { signal, crossEffectBoundary }, async () => {
    const first = prepareAdmittedExecutionOperation();
    expect(first.identity).toEqual({ ...identity, operationIndex: 0 });
    await Promise.all([
      withAdmittedExecutionCall({ ...identity, callId: "child" }, { signal, crossEffectBoundary }, async () => {
        await Promise.resolve();
        expect(prepareAdmittedExecutionOperation().identity).toEqual({ ...identity, callId: "child", operationIndex: 0 });
      }),
      Promise.resolve().then(() => expect(prepareAdmittedExecutionOperation().identity).toEqual({ ...identity, operationIndex: 1 })),
    ]);
    expect(prepareAdmittedExecutionOperation().identity).toEqual({ ...identity, operationIndex: 2 });
    expect(crossEffectBoundary).not.toHaveBeenCalled();
    first.crossEffectBoundary();
    expect(crossEffectBoundary).toHaveBeenCalledOnce();
  });
  expect(() => prepareAdmittedExecutionOperation()).toThrow(/no active admitted call/);
});

it("revokes inherited async authority and previously prepared operations when the call settles", async () => {
  let release!: () => void;
  let inherited!: Promise<void>;
  let prepared!: ReturnType<typeof prepareAdmittedExecutionOperation>;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const crossEffectBoundary = vi.fn();
  await withAdmittedExecutionCall(identity, { signal: new AbortController().signal, crossEffectBoundary }, async () => {
    prepared = prepareAdmittedExecutionOperation();
    inherited = held.then(() => { expect(() => prepareAdmittedExecutionOperation()).toThrow(/no active admitted call/); });
  });
  release();
  await inherited;
  expect(() => prepared.crossEffectBoundary()).toThrow(/no active admitted call/);
  expect(crossEffectBoundary).not.toHaveBeenCalled();
});

it("rejects cancellation after preparation before crossing the canonical boundary", async () => {
  const controller = new AbortController();
  const crossEffectBoundary = vi.fn();
  await withAdmittedExecutionCall(identity, { signal: controller.signal, crossEffectBoundary }, async () => {
    const prepared = prepareAdmittedExecutionOperation();
    controller.abort();
    expect(() => prepared.crossEffectBoundary()).toThrow(/cancelled before dispatch/);
    expect(() => prepareAdmittedExecutionOperation()).toThrow(/cancelled before dispatch/);
  });
  expect(crossEffectBoundary).not.toHaveBeenCalled();
});
