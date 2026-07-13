import { describe, expect, it } from "vitest";

import { createMonitorTool } from "../../../src/tools/system/monitor.js";

// M-EXEC-1 (core-todo.md): Monitor passes yield_time_ms = 30min but execCommand clamps it
// to 30s, so only the first ~30s streams. The description falsely claimed "Each polling
// interval (~1s), new output lines are delivered to you" for the whole run, misleading the
// model into never polling. The description now states the real ~30s window + how to poll.

describe("Monitor tool description accuracy", () => {
  it("does not claim continuous ~1s polling for the whole run", () => {
    const tool = createMonitorTool();
    const desc = tool.description;
    expect(desc).not.toContain("Each polling interval (~1s)");
    // States the real streaming window and the poll mechanism.
    expect(desc).toContain("30 seconds");
    expect(desc).toContain('write_stdin(session_id, "")');
  });
});
