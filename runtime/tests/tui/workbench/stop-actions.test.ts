import { describe, expect, it } from "vitest";

import { workbenchStopActionForTask } from "../../../src/tui/workbench/tasks/stopActions.js";

describe("workbench task stop actions", () => {
  it("routes stoppable task types to existing task helpers", () => {
    expect(workbenchStopActionForTask({ type: "local_bash", status: "running" })).toBe("local-shell");
    expect(workbenchStopActionForTask({ type: "local_agent", status: "running" })).toBe("local-agent");
    expect(workbenchStopActionForTask({ type: "in_process_teammate", status: "running" })).toBe("teammate");
  });

  it("does not expose fake stop behavior for terminal or remote tasks", () => {
    expect(workbenchStopActionForTask({ type: "local_agent", status: "completed" })).toBeNull();
    expect(workbenchStopActionForTask({ type: "remote_agent", status: "running" })).toBe("remote-unavailable");
  });
});
