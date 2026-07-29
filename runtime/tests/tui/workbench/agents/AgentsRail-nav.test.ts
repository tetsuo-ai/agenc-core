import { describe, expect, it } from "vitest";
import { nextAgentSelectionId } from "../../../../src/tui/workbench/agents/AgentsRail.js";

// The current rail deliberately keeps rows in stable first-seen order instead
// of moving them when an agent changes lifecycle state. Arrow navigation must
// follow that same rendered order, and an unkeyed target must not dispatch
// taskId: undefined.

const A = { id: "A", status: "running" };
const B = { id: "B", status: "completed" };
const C = { id: "C", status: "running" };
const taskList = [A, B, C]; // stable rendered order: A, B, C

describe("AgentsRail nextAgentSelectionId — follows stable rendered order", () => {
  it("↓ lands on the immediately following rendered row", () => {
    expect(nextAgentSelectionId(taskList, "A", 1)).toBe("B");
    expect(nextAgentSelectionId(taskList, "B", 1)).toBe("C");
  });

  it("wraps around the rendered order in both directions", () => {
    expect(nextAgentSelectionId(taskList, "C", 1)).toBe("A"); // wrap forward
    expect(nextAgentSelectionId(taskList, "A", -1)).toBe("C"); // wrap backward
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
    // selectedId null -> base index 0 (A); +1 -> B in rendered order.
    expect(nextAgentSelectionId(taskList, null, 1)).toBe("B");
  });
});
