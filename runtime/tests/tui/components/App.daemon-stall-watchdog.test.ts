import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { sourcePath } from "../../helpers/source-path.js";

describe("App daemon-stall watchdog", () => {
  test("never cancels a healthy long-running turn because the transcript is quiet", () => {
    const source = readFileSync(sourcePath("tui/components/App.tsx"), "utf8");

    expect(source).not.toContain("DAEMON_STALL_WATCHDOG_MS");
    expect(source).not.toContain("daemon_stall_watchdog");
    expect(source).not.toContain("daemon-stall-watchdog");
  });
});
