import { describe, expect, test, vi } from "vitest";
import * as leaf from "../../src/utils/attachment-message.js";
import * as producers from "../../src/utils/attachments.js";
import { formatRelevantMemoryHeader } from "../../src/memory/index.js";

describe("attachment message leaf", () => {
  test("the compatibility exports retain the same function identities", () => {
    expect(producers.createAttachmentMessage).toBe(leaf.createAttachmentMessage);
    expect(producers.isRetiredAttachmentType).toBe(leaf.isRetiredAttachmentType);
    expect(producers.memoryHeader).toBe(leaf.memoryHeader);
  });

  test("message construction keeps the original attachment and unique event identity", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
      const attachment = { type: "hook_additional_context" as const, content: ["context"], hookName: "test", toolUseID: "test", hookEvent: "SessionStart" as const };
      const first = leaf.createAttachmentMessage(attachment);
      const second = leaf.createAttachmentMessage(attachment);
      expect(first.attachment).toBe(attachment);
      expect(first.type).toBe("attachment");
      expect(first.timestamp).toBe("2026-10-04T00:00:00.000Z");
      expect(first.uuid).not.toBe(second.uuid);
      expect(leaf.memoryHeader("MEMORY.md", Date.now())).toBe(formatRelevantMemoryHeader("MEMORY.md", Date.now()));
    } finally {
      vi.useRealTimers();
    }
  });

  test("retired transcript discriminators stay filtered", () => {
    for (const name of ["autocheckpointing", "background_task_status", "mcp_resource", "todo", "task_progress", "ultramemory"]) {
      expect(leaf.isRetiredAttachmentType(name)).toBe(true);
    }
    expect(leaf.isRetiredAttachmentType("hook_additional_context")).toBe(false);
    expect(leaf.isRetiredAttachmentType("relevant_memories")).toBe(false);
  });
});
