/**
 * Tests for T11 Wave 2-A — classifier surface stub.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __listAutoModeAllowlistedToolsForTesting,
  __resetClassifierStubSessionForTesting,
  __setAutoModeGateResolverForTesting,
  __setClassifierWarningSinkForTesting,
  classifyYoloAction,
  formatActionForClassifier,
  isAutoModeAllowlistedTool,
  isAutoModeGateEnabled,
} from "./classifier.js";
import { createEmptyToolPermissionContext } from "./types.js";

describe("isAutoModeAllowlistedTool", () => {
  it("returns true for known safe tools", () => {
    for (const name of ["FileRead", "Grep", "Glob", "TodoWrite", "Sleep"]) {
      expect(isAutoModeAllowlistedTool(name)).toBe(true);
    }
  });

  it("returns false for tools not in the allowlist", () => {
    for (const name of ["Bash", "Edit", "Write", "Agent"]) {
      expect(isAutoModeAllowlistedTool(name)).toBe(false);
    }
  });

  it("exposes a stable sorted list of known tool names", () => {
    const all = __listAutoModeAllowlistedToolsForTesting();
    expect(all).toContain("FileRead");
    expect(all).toContain("YoloClassifier");
    expect(all.length).toBeGreaterThanOrEqual(20);
  });
});

describe("classifyYoloAction", () => {
  beforeEach(() => {
    __resetClassifierStubSessionForTesting();
  });

  it("falls back to manual approval for unsupported tools", async () => {
    const result = await classifyYoloAction({
      messages: [],
      action: { toolName: "SomeUnknownTool", input: { value: true } },
      tools: [],
      permissionContext: createEmptyToolPermissionContext(),
    });
    expect(result.unavailable).toBe(true);
    expect(result.shouldBlock).toBe(true);
    expect(result.reason).toContain("runtime_classifier_manual_approval_required");
    expect(result.model).toBe("runtime-heuristic");
    expect(result.stage).toBe("fast");
    expect(result.usage).toBeNull();
  });

  it("allows sandbox-safe Bash commands", async () => {
    const result = await classifyYoloAction({
      messages: [],
      action: { toolName: "Bash", input: { command: "ls src" } },
      tools: [],
      permissionContext: createEmptyToolPermissionContext(),
    });
    expect(result.shouldBlock).toBe(false);
    expect(result.unavailable).toBeUndefined();
    expect(result.reason).toBe("bash_sandbox_safe");
  });

  it("treats system.bash as the live runtime Bash surface", async () => {
    const result = await classifyYoloAction({
      messages: [],
      action: { toolName: "system.bash", input: { command: "git status" } },
      tools: [],
      permissionContext: createEmptyToolPermissionContext(),
    });
    expect(result.shouldBlock).toBe(false);
    expect(result.reason).toBe("bash_sandbox_safe");
  });

  it("normalizes local_shell argv payloads onto the Bash heuristic path", async () => {
    const result = await classifyYoloAction({
      messages: [],
      action: {
        toolName: "local_shell",
        input: { command: ["git", "status"] },
      },
      tools: [],
      permissionContext: createEmptyToolPermissionContext(),
    });
    expect(result.shouldBlock).toBe(false);
    expect(result.reason).toBe("bash_sandbox_safe");
  });

  it("blocks dangerous Bash commands", async () => {
    const result = await classifyYoloAction({
      messages: [],
      action: { toolName: "Bash", input: { command: "sudo rm -rf /" } },
      tools: [],
      permissionContext: createEmptyToolPermissionContext(),
    });
    expect(result.shouldBlock).toBe(true);
    expect(result.unavailable).toBeUndefined();
    expect(result.reason).toContain("bash_dangerous:");
  });

  it("emits the partial-runtime warning exactly once per session", async () => {
    const captured: Array<{ cause: string; message: string }> = [];
    const restore = __setClassifierWarningSinkForTesting((event) => {
      captured.push({ cause: event.cause, message: event.message });
    });
    try {
      await classifyYoloAction({
        messages: [],
        action: { toolName: "SomeUnknownTool", input: {} },
        tools: [],
        permissionContext: createEmptyToolPermissionContext(),
      });
      await classifyYoloAction({
        messages: [],
        action: { toolName: "AnotherTool", input: {} },
        tools: [],
        permissionContext: createEmptyToolPermissionContext(),
      });
      expect(captured.length).toBe(1);
      expect(captured[0]?.cause).toBe("auto_mode_classifier_partial_runtime");
    } finally {
      restore();
    }
  });

  it("respects an already-aborted signal by returning shouldBlock=true", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await classifyYoloAction({
      messages: [],
      action: { toolName: "Bash", input: {} },
      tools: [],
      permissionContext: createEmptyToolPermissionContext(),
      signal: ac.signal,
    });
    expect(result.shouldBlock).toBe(true);
    expect(result.unavailable).toBe(true);
  });
});

describe("isAutoModeGateEnabled", () => {
  afterEach(() => {
    // Belt-and-braces: make sure tests restore resolver cleanly.
    __setAutoModeGateResolverForTesting(() => false)();
  });

  it("defaults to false", () => {
    expect(isAutoModeGateEnabled()).toBe(false);
  });

  it("is overridable via the testing resolver", () => {
    const restore = __setAutoModeGateResolverForTesting(() => true);
    try {
      expect(isAutoModeGateEnabled()).toBe(true);
    } finally {
      restore();
    }
    expect(isAutoModeGateEnabled()).toBe(false);
  });
});

describe("formatActionForClassifier", () => {
  it("produces deterministic text for the same input", () => {
    const a = formatActionForClassifier("Bash", { command: "ls" });
    const b = formatActionForClassifier("Bash", { command: "ls" });
    expect(a).toBe(b);
    expect(a).toContain("Bash(");
    expect(a).toContain('"command":"ls"');
  });

  it("handles unserializable input gracefully", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const out = formatActionForClassifier("X", cyclic);
    expect(out.startsWith("X(")).toBe(true);
    expect(out).toContain("unserializable");
  });

  it("caps very large input strings", () => {
    const huge = "a".repeat(10_000);
    const out = formatActionForClassifier("Write", { content: huge });
    expect(out.length).toBeLessThanOrEqual("Write(".length + 4_096 + 2);
  });
});
