import { describe, expect, it } from "vitest";
import { nextAgentSelectionId } from "../../../../src/tui/workbench/agents/AgentsRail.js";

// M-TUI-9 (core-todo.md): arrow-nav walked the flat task list while the rail
// renders two partitioned sections (active, then background). For
// [A running, B completed, C running] the UI shows active [A, C] then
// background [B], yet ↓ from A highlighted B (flat order) — skipping C and
// jumping sections. Navigation must follow the rendered (partitioned) order,
// and an unkeyed target must not dispatch taskId: undefined.

const A = { id: "A", status: "running" };
const B = { id: "B", status: "completed" };
const C = { id: "C", status: "running" };
const taskList = [A, B, C]; // flat order: A, B, C — rendered order: A, C, B

describe("AgentsRail nextAgentSelectionId — follows rendered order", () => {
  it("↓ from an active row lands on the next active row, not the background one", () => {
    // Rendered order is [A, C, B]; ↓ from A must be C (flat order would give B).
    expect(nextAgentSelectionId(taskList, "A", 1)).toBe("C");
    expect(nextAgentSelectionId(taskList, "C", 1)).toBe("B");
  });

  it("wraps around the rendered order in both directions", () => {
    expect(nextAgentSelectionId(taskList, "B", 1)).toBe("A"); // wrap forward
    expect(nextAgentSelectionId(taskList, "A", -1)).toBe("B"); // wrap backward
  });

  it("returns null for an empty list", () => {
    expect(nextAgentSelectionId([], "A", 1)).toBeNull();
  });

  it("returns null when the target row has no stable id (no undefined dispatch)", () => {
    const unkeyed = { status: "running" }; // no id
    // Rendered order [A, unkeyed]; ↓ from A targets the unkeyed row.
    expect(nextAgentSelectionId([A, unkeyed], "A", 1)).toBeNull();
  });

  it("starts from the top of the rendered order when nothing is selected", () => {
    // selectedId null -> base index 0 (A); +1 -> C in rendered order.
    expect(nextAgentSelectionId(taskList, null, 1)).toBe("C");
  });
});
