import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { sourcePath } from "../../helpers/source-path.js";

describe("App daemon-stall watchdog", () => {
  test("waits longer than one full provider stream-idle recovery cycle", () => {
    const source = readFileSync(sourcePath("tui/components/App.tsx"), "utf8");
    const timeout = source.match(
      /const DAEMON_STALL_WATCHDOG_MS = ([\d_]+);/u,
    );

    expect(timeout).not.toBeNull();
    const timeoutMs = Number(timeout?.[1]?.replaceAll("_", ""));
    expect(timeoutMs).toBe(300_000);
    // Above the provider's 90s stream-idle limit AND the reconnect cycle
    // (re-prefill latency + another idle window) that follows a cancel.
    expect(timeoutMs).toBeGreaterThan(90_000 * 2);
  });
});
