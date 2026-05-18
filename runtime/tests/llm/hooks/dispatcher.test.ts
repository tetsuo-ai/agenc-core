import { afterEach, describe, expect, it } from "vitest";
import {
  dispatchPostCompact,
  dispatchPreCompact,
  dispatchSessionStart,
} from "./dispatcher.js";
import {
  registerPostCompactHook,
  registerPreCompactHook,
  registerSessionStartHook,
  resetLifecycleHookRegistry,
} from "./registry.js";
import type {
  PostCompactHook,
  PreCompactHook,
  SessionStartHook,
} from "./types.js";

afterEach(() => {
  resetLifecycleHookRegistry();
});

describe("dispatchPreCompact", () => {
  it("returns empty result with no registered hooks", async () => {
    const r = await dispatchPreCompact({
      hook_event_name: "PreCompact",
      trigger: "manual",
      custom_instructions: null,
    });
    expect(r).toEqual({});
  });

  it("merges successful outputs into newCustomInstructions", async () => {
    const a: PreCompactHook = () => ({
      succeeded: true,
      output: "  remember A  ",
      command: "hookA",
    });
    const b: PreCompactHook = () => ({
      succeeded: true,
      output: "remember B",
      command: "hookB",
    });
    registerPreCompactHook(a);
    registerPreCompactHook(b);

    const r = await dispatchPreCompact({
      hook_event_name: "PreCompact",
      trigger: "auto",
      custom_instructions: null,
    });
    expect(r.newCustomInstructions).toBe("remember A\n\nremember B");
    expect(r.userDisplayMessage).toBe(
      "PreCompact [hookA] completed successfully: remember A\n" +
        "PreCompact [hookB] completed successfully: remember B",
    );
  });

  it("captures failed hooks in display message and skips their output", async () => {
    registerPreCompactHook(() => ({
      succeeded: false,
      output: "boom",
      command: "hookA",
    }));
    registerPreCompactHook(() => ({
      succeeded: true,
      output: "keep",
      command: "hookB",
    }));

    const r = await dispatchPreCompact({
      hook_event_name: "PreCompact",
      trigger: "manual",
      custom_instructions: null,
    });
    expect(r.newCustomInstructions).toBe("keep");
    expect(r.userDisplayMessage).toContain("PreCompact [hookA] failed: boom");
    expect(r.userDisplayMessage).toContain(
      "PreCompact [hookB] completed successfully: keep",
    );
  });

  it("converts thrown hooks into a failed result", async () => {
    registerPreCompactHook(() => {
      throw new Error("bad");
    });
    const r = await dispatchPreCompact({
      hook_event_name: "PreCompact",
      trigger: "manual",
      custom_instructions: null,
    });
    expect(r.newCustomInstructions).toBeUndefined();
    expect(r.userDisplayMessage).toContain("PreCompact [PreCompact] failed: bad");
  });

  it("respects abort signal between hooks", async () => {
    const ac = new AbortController();
    let calls = 0;
    const a: PreCompactHook = () => {
      calls += 1;
      ac.abort();
      return { succeeded: true, output: "" };
    };
    const b: PreCompactHook = () => {
      calls += 1;
      return { succeeded: true, output: "should-not-run" };
    };
    await dispatchPreCompact(
      {
        hook_event_name: "PreCompact",
        trigger: "manual",
        custom_instructions: null,
      },
      { hooks: [a, b], signal: ac.signal },
    );
    // First hook ran and aborted; second never ran.
    expect(calls).toBe(1);
  });
});

describe("dispatchPostCompact", () => {
  it("returns empty when no hooks", async () => {
    const r = await dispatchPostCompact({
      hook_event_name: "PostCompact",
      trigger: "manual",
      compact_summary: "summary",
    });
    expect(r).toEqual({});
  });

  it("aggregates display messages but not custom instructions", async () => {
    const a: PostCompactHook = () => ({
      succeeded: true,
      output: "ok",
      command: "h1",
    });
    const b: PostCompactHook = () => ({
      succeeded: false,
      output: "",
      command: "h2",
    });
    registerPostCompactHook(a);
    registerPostCompactHook(b);

    const r = await dispatchPostCompact({
      hook_event_name: "PostCompact",
      trigger: "auto",
      compact_summary: "summary",
    });
    expect(r.userDisplayMessage).toBe(
      "PostCompact [h1] completed successfully: ok\nPostCompact [h2] failed",
    );
    // PostCompact must never expose newCustomInstructions.
    expect((r as Record<string, unknown>).newCustomInstructions).toBeUndefined();
  });
});

describe("dispatchSessionStart", () => {
  it("returns empty array with no hooks", async () => {
    const r = await dispatchSessionStart({
      hook_event_name: "SessionStart",
      source: "compact",
    });
    expect(r).toEqual([]);
  });

  it("returns hook messages and a single additional-context envelope", async () => {
    const a: SessionStartHook = () => ({
      succeeded: true,
      output: "",
      message: { type: "user", role: "user", content: "from-hook-a" },
    });
    const b: SessionStartHook = () => ({
      succeeded: true,
      output: "",
      additionalContexts: ["ctx-b1", "ctx-b2"],
    });
    const c: SessionStartHook = () => ({
      succeeded: true,
      output: "",
      additionalContexts: ["ctx-c"],
    });
    registerSessionStartHook(a);
    registerSessionStartHook(b);
    registerSessionStartHook(c);

    const r = await dispatchSessionStart({
      hook_event_name: "SessionStart",
      source: "compact",
      model: "test-model",
    });

    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      type: "user",
      role: "user",
      content: "from-hook-a",
    });
    expect(r[1]).toMatchObject({
      type: "hook_additional_context",
      hookEvent: "SessionStart",
      hookName: "SessionStart",
      content: ["ctx-b1", "ctx-b2", "ctx-c"],
    });
  });

  it("returns stopped session-start hook messages with context envelope", async () => {
    const hook: SessionStartHook = () => ({
      succeeded: false,
      output: "pause session",
      message: {
        type: "hook_stopped_continuation",
        hookEvent: "SessionStart",
        hookName: "SessionStart",
        message: "pause session",
      },
      additionalContexts: ["ctx-before-stop"],
    });
    registerSessionStartHook(hook);

    const r = await dispatchSessionStart({
      hook_event_name: "SessionStart",
      source: "startup",
      model: "test-model",
    });

    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({
      type: "hook_stopped_continuation",
      hookEvent: "SessionStart",
      message: "pause session",
    });
    expect(r[1]).toMatchObject({
      type: "hook_additional_context",
      hookEvent: "SessionStart",
      content: ["ctx-before-stop"],
    });
  });
});
