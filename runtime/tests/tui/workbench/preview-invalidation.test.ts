import { describe, expect, it } from "vitest";

import type { TaskState } from "../../../src/tasks/types.js";
import {
  previewFileRevisionKey,
  previewTaskEpoch,
} from "../../../src/tui/workbench/previewInvalidation.js";
import { previewAgentTask } from "./preview-invalidation-fixtures.js";

function epochFor(
  pathValue: string | null,
  ...rows: TaskState[]
): string {
  return previewTaskEpoch(
    Object.fromEntries(rows.map((row) => [row.id, row])),
    pathValue,
  );
}

describe("previewTaskEpoch", () => {
  it("ignores tasks that do not reference the selected path", () => {
    expect(
      epochFor(
        "target.ts",
        previewAgentTask({
          id: "agent-other",
          status: "running",
          prompt: "other.ts",
        }),
      ),
    ).toBe("");
  });

  it("changes when a referencing task starts or completes", () => {
    const running = epochFor(
      "target.ts",
      previewAgentTask({ id: "agent-1", status: "running" }),
    );
    const completed = epochFor(
      "target.ts",
      previewAgentTask({
        id: "agent-1",
        status: "completed",
        endTime: 12,
      }),
    );

    expect(running).toContain("agent-1:running:");
    expect(completed).toBe("agent-1:completed:12");
    expect(completed).not.toBe(running);
  });

  it("does not change when only progress chatter updates", () => {
    const before = epochFor(
      "target.ts",
      previewAgentTask({ id: "agent-1", status: "running" }),
    );
    const after = epochFor(
      "target.ts",
      previewAgentTask({
        id: "agent-1",
        status: "running",
        lastReportedTokenCount: 99,
        progress: {
          lastActivity: { activityDescription: "still editing target.ts" },
        },
      }),
    );

    expect(after).toBe(before);
  });

  it("returns an empty epoch when no path is selected", () => {
    expect(
      epochFor(
        null,
        previewAgentTask({ id: "agent-1", status: "running" }),
      ),
    ).toBe("");
  });
});

describe("previewFileRevisionKey", () => {
  it("identifies missing files separately from a disk revision", () => {
    expect(previewFileRevisionKey(null)).toBe("missing");
    expect(previewFileRevisionKey({ mtimeMs: 10, size: 4, ino: 7 })).toBe(
      "10:4:7",
    );
  });
});
