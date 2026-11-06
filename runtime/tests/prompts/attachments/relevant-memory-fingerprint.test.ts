import { describe, expect, test } from "vitest";

import { relevantMemoryFingerprint } from "../../../src/prompts/attachments/relevant-memory-fingerprint.js";
import type { RelevantMemoriesAttachment } from "../../../src/prompts/attachments/types.js";

type SurfacedMemory = RelevantMemoriesAttachment["memories"][number];

function memory(overrides: Partial<SurfacedMemory> = {}): SurfacedMemory {
  return {
    path: "/home/user/.agenc/memory/browser.md",
    content: "Use the browser automation workflow.",
    mtimeMs: 1_700_000_000_000,
    header: "## browser.md (mtime: yesterday)",
    limit: 200,
    selectionSource: "reranked",
    citation: {
      path: "/home/user/.agenc/memory/browser.md",
      lineStart: 1,
      lineEnd: 12,
      note: "selected",
      rolloutIds: ["relevant-memory-attachment"],
    },
    ...overrides,
  };
}

describe("relevantMemoryFingerprint", () => {
  test("identity ignores citation metadata, mtime, and selection source", () => {
    const original = relevantMemoryFingerprint(memory());
    expect(relevantMemoryFingerprint(memory({
      mtimeMs: 1_800_000_000_000,
      selectionSource: "lexical",
      citation: {
        path: "/other/path.md",
        lineStart: 99,
        lineEnd: 100,
        note: "later round",
        rolloutIds: ["other-rollout"],
      },
    }))).toBe(original);
    expect(relevantMemoryFingerprint(memory({ citation: undefined }))).toBe(original);
  });

  test("path, header, content, and truncation limit each change identity", () => {
    const original = relevantMemoryFingerprint(memory());
    expect(relevantMemoryFingerprint(memory({ path: "/other.md" }))).not.toBe(original);
    expect(relevantMemoryFingerprint(memory({ header: "## other" }))).not.toBe(original);
    expect(relevantMemoryFingerprint(memory({ header: undefined }))).not.toBe(original);
    expect(relevantMemoryFingerprint(memory({
      content: "Use the browser automation workflow with the updated deployment setting.",
    }))).not.toBe(original);
    expect(relevantMemoryFingerprint(memory({ limit: 100 }))).not.toBe(original);
    expect(relevantMemoryFingerprint(memory({ limit: undefined }))).not.toBe(original);
  });
});
