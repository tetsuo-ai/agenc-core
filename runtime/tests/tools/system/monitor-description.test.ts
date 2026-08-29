import { describe, expect, it } from "vitest";

import { createMonitorTool } from "../../../src/tools/system/monitor.js";

// M-EXEC-1: the description must state the bounded streaming window and the
// explicit polling mechanism for a process that remains active afterward.

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
