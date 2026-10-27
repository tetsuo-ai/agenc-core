import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

// Stops processes at fork, readiness and exec checkpoints, which the release
// test boundary's seccomp profile forbids, so it runs in the real-kernel lane.
describe("native AGB2 owner-death lifecycle", () => {
  it("checks owner death around fork/readiness/exec and repeated descriptor failures", () => {
    execFileSync("python3", [fileURLToPath(new URL("./process-broker-v2.lifecycle.py", import.meta.url))], {
      timeout: 90_000, maxBuffer: 1024 * 1024, encoding: "utf8",
    });
  }, 95_000);
});
