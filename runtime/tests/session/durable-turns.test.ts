/**
 * GOAL #4b Stage 1 — durable-turns shared primitives.
 *
 * Covers the build pin, config resolution, the CONTENT prefix hash
 * (write-side ↔ read-side consistency + divergence detection), dangling
 * tool_use detection/classification, and the `isResumeReplaySafe`
 * recovery-category rule.
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  classifyDanglingToolUses,
  computePrefixHash,
  currentBuildId,
  findDanglingToolUses,
  resetBuildIdForTestingOnly,
  resolveDurableTurnsConfig,
} from "./durable-turns.js";
import { isResumeReplaySafe } from "../tool-registry.js";
import type { ResponseItem } from "./rollout-item.js";

afterEach(() => {
  delete process.env.AGENC_BUILD_ID;
  delete process.env.AGENC_BUILD_COMMIT;
  delete process.env.AGENC_DURABLE_TURNS;
  delete process.env.AGENC_DURABLE_TURNS_RESUME;
  resetBuildIdForTestingOnly();
});

describe("currentBuildId", () => {
  test("AGENC_BUILD_ID wins outright and is stable", () => {
    process.env.AGENC_BUILD_ID = "pinned-build-xyz";
    resetBuildIdForTestingOnly();
    expect(currentBuildId()).toBe("pinned-build-xyz");
    expect(currentBuildId()).toBe("pinned-build-xyz"); // memoized
  });

  test("falls back to VERSION+commit when no explicit id", () => {
    process.env.AGENC_BUILD_COMMIT = "abcdef0123456789";
    resetBuildIdForTestingOnly();
    expect(currentBuildId()).toMatch(/^\d+\.\d+\.\d+\+abcdef012345$/);
  });
});

describe("resolveDurableTurnsConfig", () => {
  test("conservative defaults: checkpoint on, resume on, policy safe, lease+pin on", () => {
    const cfg = resolveDurableTurnsConfig(undefined);
    expect(cfg.checkpointEnabled).toBe(true);
    expect(cfg.resumeOnRestart).toBe(true);
    expect(cfg.resumePolicy).toBe("safe");
    expect(cfg.requireLease).toBe(true);
    expect(cfg.buildPinning).toBe(true);
  });

  test("AGENC_DURABLE_TURNS=0 disables checkpoint AND resume", () => {
    process.env.AGENC_DURABLE_TURNS = "0";
    const cfg = resolveDurableTurnsConfig(undefined);
    expect(cfg.checkpointEnabled).toBe(false);
    expect(cfg.resumeOnRestart).toBe(false);
  });

  test("policy is clamped to safe even if config requests idempotent (Stage 1)", () => {
    const cfg = resolveDurableTurnsConfig({
      durableTurns: { resume: { policy: "idempotent" } },
    });
    expect(cfg.resumePolicy).toBe("safe");
  });

  test("explicit config disables resume while leaving checkpoint on", () => {
    const cfg = resolveDurableTurnsConfig({
      durableTurns: { resume: { onRestart: false } },
    });
    expect(cfg.checkpointEnabled).toBe(true);
    expect(cfg.resumeOnRestart).toBe(false);
  });
});

describe("computePrefixHash", () => {
  test("is a real content hash, not a length (different content → different hash)", () => {
    const a: ResponseItem[] = [{ role: "user", content: "hello" }];
    const b: ResponseItem[] = [{ role: "user", content: "world" }];
    expect(computePrefixHash(a, 1)).not.toBe(computePrefixHash(b, 1));
    // Same length, same hash only when content identical.
    expect(computePrefixHash(a, 1)).toBe(
      computePrefixHash([{ role: "user", content: "hello" }], 1),
    );
  });

  test("detects a reordered prefix (threading divergence)", () => {
    const ordered: ResponseItem[] = [
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ];
    const swapped: ResponseItem[] = [
      { role: "assistant", content: "a" },
      { role: "user", content: "u" },
    ];
    expect(computePrefixHash(ordered, 2)).not.toBe(
      computePrefixHash(swapped, 2),
    );
  });

  test("tool-output BODY does not affect the hash (bound/truncation stable), but its threading linkage does", () => {
    const small: ResponseItem[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read", arguments: "{}" }],
      },
      { role: "tool", content: "short result", toolCallId: "c1", toolName: "read" },
    ];
    const large: ResponseItem[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read", arguments: "{}" }],
      },
      {
        role: "tool",
        content: "short result PLUS extra bytes that a bound would clear",
        toolCallId: "c1",
        toolName: "read",
      },
    ];
    // Different tool-output bodies, same threading → SAME hash (so an
    // in-memory bound / replay truncation cannot spuriously mismatch).
    expect(computePrefixHash(small, 2)).toBe(computePrefixHash(large, 2));
    // But changing the toolCallId linkage DOES change the hash.
    const relinked: ResponseItem[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read", arguments: "{}" }],
      },
      { role: "tool", content: "short result", toolCallId: "c2", toolName: "read" },
    ];
    expect(computePrefixHash(small, 2)).not.toBe(
      computePrefixHash(relinked, 2),
    );
  });
});

describe("findDanglingToolUses", () => {
  test("flags an assistant tool_use with no paired tool result", () => {
    const prefix: ResponseItem[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "paired", name: "read", arguments: "{}" },
          { id: "dangling", name: "send", arguments: "{}" },
        ],
      },
      { role: "tool", content: "ok", toolCallId: "paired", toolName: "read" },
    ];
    const dangling = findDanglingToolUses(prefix);
    expect(dangling).toEqual([{ callId: "dangling", toolName: "send" }]);
  });

  test("no dangling when every tool_use has a result", () => {
    const prefix: ResponseItem[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read", arguments: "{}" }],
      },
      { role: "tool", content: "ok", toolCallId: "c1", toolName: "read" },
    ];
    expect(findDanglingToolUses(prefix)).toEqual([]);
  });
});

describe("classifyDanglingToolUses + isResumeReplaySafe", () => {
  test("read-only/idempotent is replay-safe; side-effecting/interactive/unknown halts", () => {
    expect(
      isResumeReplaySafe({ isReadOnly: true, recoveryCategory: "idempotent" }),
    ).toBe(true);
    expect(isResumeReplaySafe({ recoveryCategory: "side-effecting" })).toBe(
      false,
    );
    expect(isResumeReplaySafe({ recoveryCategory: "interactive" })).toBe(false);
    // Missing category → not trusted (caller treats unknown as halt anyway).
    expect(isResumeReplaySafe({})).toBe(false);
    // requiresUserInteraction → never safe even if read-only.
    expect(
      isResumeReplaySafe({
        isReadOnly: true,
        recoveryCategory: "idempotent",
        requiresUserInteraction: () => true,
      }),
    ).toBe(false);
  });

  test("classify partitions by the supplied safety predicate", () => {
    const dangling = [
      { callId: "a", toolName: "read" },
      { callId: "b", toolName: "send" },
    ];
    const safeNames = new Set(["read"]);
    const { replaySafe, mustHalt } = classifyDanglingToolUses(dangling, (n) =>
      safeNames.has(n),
    );
    expect(replaySafe).toEqual([{ callId: "a", toolName: "read" }]);
    expect(mustHalt).toEqual([{ callId: "b", toolName: "send" }]);
  });
});
