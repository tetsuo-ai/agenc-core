import { describe, expect, it } from "vitest";
import { nextShellTailState } from "../../../src/tui/workbench/surfaces/ShellSurface.js";

// core-todo.md ShellSurface.tsx:39 — the tail effect re-runs on [task.id,
// task.status] and unconditionally blanked the tail, so a running->completed
// transition flashed the output empty for one cycle. It now preserves content
// when the task is unchanged (mirrors AgentSurface).

describe("nextShellTailState", () => {
  it("preserves content on a status change (same task)", () => {
    const current = { taskId: "task-1", content: "existing output" };
    // Same task id -> return the SAME object (no blank, no re-render churn).
    expect(nextShellTailState(current, "task-1")).toBe(current);
  });

  it("blanks when switching to a different task", () => {
    const current = { taskId: "task-1", content: "existing output" };
    expect(nextShellTailState(current, "task-2")).toEqual({
      taskId: "task-2",
      content: "",
    });
  });

  it("blanks from an empty initial state", () => {
    const current = { taskId: null, content: "" };
    expect(nextShellTailState(current, "task-1")).toEqual({
      taskId: "task-1",
      content: "",
    });
  });
});
