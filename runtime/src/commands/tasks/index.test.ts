// @ts-nocheck
import { describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../../tools.js", () => ({
  getAllTools: () => [],
  getDefaultTools: () => [],
}));

const tasksCommand = (await import("./index.js")).default;

describe("tasks command metadata", () => {
  it("declares the right name + type + aliases", () => {
    expect(tasksCommand.type).toBe("local-jsx");
    expect(tasksCommand.name).toBe("tasks");
    expect(tasksCommand.aliases).toContain("bashes");
    expect(tasksCommand.description).toContain("background tasks");
  });

  it("declares a load() function for lazy import of the dialog", () => {
    // The module the load() returns can't be imported in vitest because
    // BackgroundTasksPanel pulls in the full Ink + daemon-task tree.
    // Asserting that load is a function is enough to verify the
    // command-spec contract is satisfied; the actual JSX render is
    // covered by the PTY scenario.
    expect(typeof tasksCommand.load).toBe("function");
  });
});
