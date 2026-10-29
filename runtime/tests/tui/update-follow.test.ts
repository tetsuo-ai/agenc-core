import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDaemonRuntimeVersion, updateFollowReady } from "../../src/tui/hooks/useUpdateFollow.js";

const request = {
  fromVersion: "0.19.25", targetVersion: "0.19.26", command: "/w/agenc", installType: "install.sh" as const, cwd: "/w",
};

describe("following an update", () => {
  it("waits only for idle after this turn, and for the daemon after a busy restart", () => {
    expect(updateFollowReady({ request, when: "idle" }, "0.19.25", true)).toBe(true);
    expect(updateFollowReady({ request, when: "daemon" }, "0.19.25", true)).toBe(false);
    expect(updateFollowReady({ request, when: "daemon" }, undefined, true)).toBe(false);
    expect(updateFollowReady({ request, when: "daemon" }, "0.19.26", true)).toBe(true);
    // Between stop and start the sidecar is gone but the restart is pending.
    expect(updateFollowReady({ request, when: "daemon" }, null, true)).toBe(false);
    // No daemon and nothing pending: the new version starts its own.
    expect(updateFollowReady({ request, when: "daemon" }, null, false)).toBe(true);
  });

  it("reads the daemon's version from its sidecar", () => {
    const home = mkdtempSync(join(tmpdir(), "follow-"));
    try {
      expect(readDaemonRuntimeVersion(home)).toBeNull();
      writeFileSync(join(home, "daemon-runtime.json"), JSON.stringify({ pid: 5, runtimeVersion: "0.19.26" }));
      expect(readDaemonRuntimeVersion(home)).toBe("0.19.26");
      writeFileSync(join(home, "daemon-runtime.json"), "{");
      expect(readDaemonRuntimeVersion(home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
