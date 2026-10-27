import { describe, expect, it } from "vitest";

import {
  queueTuiStartupNotice,
  takeTuiStartupNotices,
} from "../../src/tui/startup-notices.js";

describe("TUI startup notices", () => {
  it("hands each queued notice over once and drops a repeated key", () => {
    takeTuiStartupNotices();
    queueTuiStartupNotice({ key: "sandbox-unavailable", text: "No sandbox" });
    queueTuiStartupNotice({ key: "sandbox-unavailable", text: "No sandbox again" });
    queueTuiStartupNotice({ key: "other", text: "Other" });
    expect(takeTuiStartupNotices()).toEqual([
      { key: "sandbox-unavailable", text: "No sandbox" },
      { key: "other", text: "Other" },
    ]);
    expect(takeTuiStartupNotices()).toEqual([]);
  });
});
