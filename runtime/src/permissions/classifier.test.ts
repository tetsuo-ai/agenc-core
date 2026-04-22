/**
 * Tests for T13 — xAI-backed auto-mode classifier surface.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __listAutoModeAllowlistedToolsForTesting,
  __resetClassifierStubSessionForTesting,
  __setAutoModeGateResolverForTesting,
  __setRemoteClassifierStageRunnerForTesting,
  __setClassifierWarningSinkForTesting,
  classifyYoloAction,
  formatActionForClassifier,
  isAutoModeAllowlistedTool,
  isAutoModeGateEnabled,
} from "./classifier.js";
import { createEmptyToolPermissionContext } from "./types.js";

const AUTO_MODE_ENV_KEYS = [
  "XAI_API_KEY",
  "GROK_API_KEY",
  "AGENC_XAI_API_KEY",
] as const;

function withAutoModeEnv<T>(
  overrides: Partial<Record<(typeof AUTO_MODE_ENV_KEYS)[number], string | undefined>>,
  body: () => Promise<T> | T,
): Promise<T> | T {
  const previous = Object.fromEntries(
    AUTO_MODE_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof AUTO_MODE_ENV_KEYS)[number], string | undefined>;
  for (const key of AUTO_MODE_ENV_KEYS) {
    const next = overrides[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  try {
    return body();
  } finally {
    for (const key of AUTO_MODE_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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

  it("falls back to manual approval for unsupported tools when xAI is not configured", async () => {
    const captured: Array<{ cause: string; message: string }> = [];
    const restoreSink = __setClassifierWarningSinkForTesting((event) => {
      captured.push({ cause: event.cause, message: event.message });
    });
    try {
      await withAutoModeEnv({}, async () => {
        const result = await classifyYoloAction({
          messages: [],
          action: { toolName: "SomeUnknownTool", input: { value: true } },
          tools: [],
          permissionContext: createEmptyToolPermissionContext(),
        });
        expect(result.unavailable).toBe(true);
        expect(result.shouldBlock).toBe(true);
        expect(result.reason).toContain(
          "runtime_classifier_manual_approval_required",
        );
        expect(result.model).toBe("grok-4");
        expect(result.stage).toBe("thinking");
        expect(result.stage1Model).toBe("grok-4-fast");
        expect(result.stage2Model).toBe("grok-4");
        expect(result.usage).toBeNull();
      });
      expect(captured).toHaveLength(1);
      expect(captured[0]?.cause).toBe("auto_mode_classifier_missing_xai_api_key");
    } finally {
      restoreSink();
    }
  });

  it("auto-allows safe allowlisted tools in the fast stage", async () => {
    const result = await classifyYoloAction({
      messages: [],
      action: { toolName: "FileRead", input: { path: "README.md" } },
      tools: [],
      permissionContext: createEmptyToolPermissionContext(),
    });
    expect(result.shouldBlock).toBe(false);
    expect(result.reason).toBe("allowlisted_tool");
    expect(result.stage).toBe("fast");
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
    expect(result.stage).toBe("fast");
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
    expect(result.stage).toBe("fast");
  });

  it("uses the remote fast stage when xAI is configured", async () => {
    const calls: Array<{ stage: string; userPrompt: string }> = [];
    const restoreRunner = __setRemoteClassifierStageRunnerForTesting(
      async (request) => {
        calls.push({ stage: request.stage, userPrompt: request.userPrompt });
        return {
          shouldBlock: false,
          reason: "remote_fast_allow",
          usage: { inputTokens: 12, outputTokens: 4 },
          model: request.model,
        };
      },
    );
    try {
      await withAutoModeEnv({ XAI_API_KEY: "test-key" }, async () => {
        const result = await classifyYoloAction({
          messages: [
            { role: "user", content: "Update the changelog" },
            {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "call_1",
                  name: "FileRead",
                  arguments: "{\"path\":\"CHANGELOG.md\"}",
                },
              ],
            },
          ],
          action: { toolName: "Edit", input: { path: "CHANGELOG.md" } },
          tools: [],
          permissionContext: createEmptyToolPermissionContext(),
        });
        expect(result.shouldBlock).toBe(false);
        expect(result.reason).toBe("remote_fast_allow");
        expect(result.stage).toBe("fast");
        expect(result.model).toBe("grok-4-fast");
        expect(result.stage1Model).toBe("grok-4-fast");
        expect(result.stage1Usage).toEqual({ inputTokens: 12, outputTokens: 4 });
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.stage).toBe("fast");
      expect(calls[0]?.userPrompt).toContain("USER Update the changelog");
      expect(calls[0]?.userPrompt).toContain("ASSISTANT_TOOL FileRead(");
      expect(calls[0]?.userPrompt).toContain("Edit(");
    } finally {
      restoreRunner();
    }
  });

  it("escalates from the fast stage to the thinking stage when the fast stage blocks", async () => {
    const calls: string[] = [];
    const restoreRunner = __setRemoteClassifierStageRunnerForTesting(
      async (request) => {
        calls.push(request.stage);
        if (request.stage === "fast") {
          return {
            shouldBlock: true,
            reason: "fast_stage_block",
            usage: { inputTokens: 8, outputTokens: 2 },
            model: request.model,
          };
        }
        return {
          shouldBlock: false,
          reason: "thinking_stage_allow",
          thinking: "The user explicitly asked for this scoped edit.",
          usage: { inputTokens: 20, outputTokens: 6 },
          model: request.model,
        };
      },
    );
    try {
      await withAutoModeEnv({ GROK_API_KEY: "test-key" }, async () => {
        const result = await classifyYoloAction({
          messages: [{ role: "user", content: "Refactor just the permission classifier." }],
          action: { toolName: "Edit", input: { path: "runtime/src/permissions/classifier.ts" } },
          tools: [],
          permissionContext: createEmptyToolPermissionContext(),
        });
        expect(result.shouldBlock).toBe(false);
        expect(result.reason).toBe("thinking_stage_allow");
        expect(result.thinking).toContain("explicitly asked");
        expect(result.stage).toBe("thinking");
        expect(result.model).toBe("grok-4");
        expect(result.stage1Model).toBe("grok-4-fast");
        expect(result.stage2Model).toBe("grok-4");
        expect(result.stage1Usage).toEqual({ inputTokens: 8, outputTokens: 2 });
        expect(result.stage2Usage).toEqual({ inputTokens: 20, outputTokens: 6 });
      });
      expect(calls).toEqual(["fast", "thinking"]);
    } finally {
      restoreRunner();
    }
  });

  it("emits the missing-key warning exactly once per session", async () => {
    const captured: Array<{ cause: string; message: string }> = [];
    const restore = __setClassifierWarningSinkForTesting((event) => {
      captured.push({ cause: event.cause, message: event.message });
    });
    try {
      await withAutoModeEnv({}, async () => {
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
      });
      expect(captured.length).toBe(1);
      expect(captured[0]?.cause).toBe("auto_mode_classifier_missing_xai_api_key");
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

  it("defaults to false when no xAI key is configured", () => {
    withAutoModeEnv({}, () => {
      expect(isAutoModeGateEnabled()).toBe(false);
    });
  });

  it("turns on when an xAI key is configured", () => {
    withAutoModeEnv({ XAI_API_KEY: "test-key" }, () => {
      expect(isAutoModeGateEnabled()).toBe(true);
    });
  });

  it("is overridable via the testing resolver", () => {
    withAutoModeEnv({}, () => {
      const restore = __setAutoModeGateResolverForTesting(() => true);
      try {
        expect(isAutoModeGateEnabled()).toBe(true);
      } finally {
        restore();
      }
      expect(isAutoModeGateEnabled()).toBe(false);
    });
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
