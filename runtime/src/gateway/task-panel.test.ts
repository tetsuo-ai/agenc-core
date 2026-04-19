import { describe, expect, it } from "vitest";
import type { RuntimeTaskHandle } from "../runtime-contract/types.js";
import {
  buildTaskPanelView,
  buildTaskPanelViewFromSnapshot,
  formatTaskPanelLines,
} from "./task-panel.js";

function handle(
  overrides: Partial<RuntimeTaskHandle> & Pick<RuntimeTaskHandle, "id" | "status">,
): RuntimeTaskHandle {
  return {
    kind: "manual",
    ...overrides,
  };
}

describe("buildTaskPanelView", () => {
  it("partitions by status and sorts by updatedAt desc", () => {
    const view = buildTaskPanelView({
      openTasks: [
        handle({
          id: "1",
          status: "pending",
          subject: "Older pending",
          updatedAt: 10,
        }),
        handle({
          id: "2",
          status: "in_progress",
          subject: "Older in-progress",
          activeForm: "Running older",
          updatedAt: 20,
        }),
        handle({
          id: "3",
          status: "in_progress",
          subject: "Newest",
          activeForm: "Running newest",
          updatedAt: 100,
        }),
        handle({
          id: "4",
          status: "pending",
          subject: "Newer pending",
          updatedAt: 50,
        }),
      ],
    });

    expect(view.inProgress.map((t) => t.id)).toEqual(["3", "2"]);
    expect(view.pending.map((t) => t.id)).toEqual(["4", "1"]);
  });

  it("prefers activeForm when in_progress, subject otherwise", () => {
    const view = buildTaskPanelView({
      openTasks: [
        handle({
          id: "1",
          status: "in_progress",
          subject: "Run tests",
          activeForm: "Running tests",
        }),
        handle({
          id: "2",
          status: "pending",
          subject: "Ship it",
          activeForm: "Shipping it",
        }),
      ],
    });
    expect(view.inProgress[0]?.label).toBe("Running tests");
    expect(view.pending[0]?.label).toBe("Ship it");
  });

  it("falls back to summary then kind when neither subject nor activeForm is set", () => {
    const view = buildTaskPanelView({
      openTasks: [
        handle({
          id: "1",
          status: "pending",
          summary: "summary-only",
        }),
        handle({ id: "2", status: "pending", kind: "verifier" }),
      ],
    });
    expect(view.pending[0]?.label).toBe("summary-only");
    expect(view.pending[1]?.label).toBe("verifier task");
  });

  it("passes through recent-completed tail without filtering", () => {
    const view = buildTaskPanelView({
      openTasks: [],
      recentCompletedTasks: [
        handle({ id: "9", status: "completed", subject: "Old win", updatedAt: 1 }),
        handle({ id: "10", status: "failed", subject: "New loss", updatedAt: 2 }),
      ],
    });
    expect(view.recentCompleted.map((t) => t.id)).toEqual(["10", "9"]);
  });

  it("propagates omittedTaskCount onto the view", () => {
    const view = buildTaskPanelView({
      openTasks: [],
      omittedTaskCount: 5,
    });
    expect(view.omittedOpenCount).toBe(5);
  });
});

describe("buildTaskPanelViewFromSnapshot", () => {
  it("returns undefined when the snapshot is missing", () => {
    expect(buildTaskPanelViewFromSnapshot(undefined)).toBeUndefined();
  });
});

describe("formatTaskPanelLines", () => {
  it("returns an empty array when the panel is empty and no empty message is set", () => {
    const lines = formatTaskPanelLines({
      inProgress: [],
      pending: [],
      recentCompleted: [],
      omittedOpenCount: 0,
    });
    expect(lines).toEqual([]);
  });

  it("emits a header plus an entry per task with status icons", () => {
    const lines = formatTaskPanelLines(
      buildTaskPanelView({
        openTasks: [
          handle({
            id: "1",
            status: "in_progress",
            subject: "s",
            activeForm: "Running migration",
            owner: "agent-a",
          }),
          handle({ id: "2", status: "pending", subject: "Write docs" }),
        ],
      }),
    );
    expect(lines[0]).toBe("Tasks");
    expect(lines.some((line) => line.includes("Running migration"))).toBe(true);
    expect(lines.some((line) => line.includes("(agent-a)"))).toBe(true);
    expect(lines.some((line) => line.startsWith("o #2"))).toBe(true);
  });

  it("emits an overflow marker when omittedOpenCount > 0", () => {
    const lines = formatTaskPanelLines(
      buildTaskPanelView({
        openTasks: [handle({ id: "1", status: "pending", subject: "t" })],
        omittedTaskCount: 7,
      }),
    );
    expect(lines.some((line) => line.includes("+7 more not shown"))).toBe(true);
  });

  it("emits a recent-completed section when tail entries exist", () => {
    const lines = formatTaskPanelLines(
      buildTaskPanelView({
        openTasks: [],
        recentCompletedTasks: [
          handle({ id: "9", status: "completed", subject: "Shipped feature" }),
        ],
      }),
    );
    expect(lines).toContain("Recently completed");
    expect(lines.some((line) => line.includes("Shipped feature"))).toBe(true);
  });

  it("truncates labels that exceed maxLabelLength", () => {
    const longLabel = "x".repeat(200);
    const lines = formatTaskPanelLines(
      buildTaskPanelView({
        openTasks: [
          handle({ id: "1", status: "pending", subject: longLabel }),
        ],
      }),
      { maxLabelLength: 20 },
    );
    const entryLine = lines.find((line) => line.startsWith("o #1"));
    expect(entryLine).toBeDefined();
    expect(entryLine!.length).toBeLessThanOrEqual(40);
    expect(entryLine).toContain("\u2026");
  });

  it("shows [output ready] when the task has finalized output", () => {
    const lines = formatTaskPanelLines(
      buildTaskPanelView({
        openTasks: [
          handle({
            id: "1",
            status: "in_progress",
            subject: "Delegated work",
            outputReady: true,
          }),
        ],
      }),
    );
    expect(lines.some((line) => line.includes("[output ready]"))).toBe(true);
  });
});
