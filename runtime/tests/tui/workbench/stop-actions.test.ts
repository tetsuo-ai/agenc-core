import { describe, expect, it } from "vitest";

import { workbenchStopActionForTask } from "../../../src/tui/workbench/tasks/stopActions.js";

describe("workbench task stop actions", () => {
  it("routes stoppable task types to existing task helpers", () => {
    expect(workbenchStopActionForTask({ type: "local_bash", status: "running" })).toBe("local-shell");
    expect(workbenchStopActionForTask({ type: "local_agent", status: "running" })).toBe("local-agent");
    expect(workbenchStopActionForTask({ type: "in_process_teammate", status: "running" })).toBe("teammate");
  });

  it("matches type-specific stop helper state support", () => {
    expect(workbenchStopActionForTask({ type: "local_bash", status: "pending" })).toBeNull();
    expect(workbenchStopActionForTask({ type: "local_agent", status: "pending" })).toBe("local-agent");
    expect(workbenchStopActionForTask({ type: "in_process_teammate", status: "pending" })).toBeNull();
    expect(workbenchStopActionForTask({
      type: "in_process_teammate",
      status: "running",
      shutdownRequested: true,
    })).toBeNull();
    expect(workbenchStopActionForTask({
      type: "in_process_teammate",
      status: "running",
      shutdownRequested: false,
    })).toBe("teammate");
  });

  it("does not expose fake stop behavior for terminal or unknown task kinds", () => {
    expect(workbenchStopActionForTask({ type: "local_agent", status: "completed" })).toBeNull();
    // remote_agent was deleted as an unshipped scaffold; a stale record with
    // that kind (e.g. from an old session) must fall through to "no stop action".
    expect(
      workbenchStopActionForTask({ type: "remote_agent", status: "running" } as never),
    ).toBeNull();
  });
});
