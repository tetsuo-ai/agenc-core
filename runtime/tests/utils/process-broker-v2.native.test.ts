import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

describe.skipIf(process.platform !== "linux")("native AGB2 defensive protocol", () => {
  it("validates frames, descriptors, seals and original-owner adoption", () => {
    execFileSync("python3", [fileURLToPath(new URL("./process-broker-v2.native.py", import.meta.url))], {
      timeout: 90_000, maxBuffer: 1024 * 1024, encoding: "utf8",
    });
  }, 95_000);
  it("checks owner death around fork/readiness/exec and repeated descriptor failures", () => {
    execFileSync("python3", [fileURLToPath(new URL("./process-broker-v2.lifecycle.py", import.meta.url))], {
      timeout: 90_000, maxBuffer: 1024 * 1024, encoding: "utf8",
    });
  }, 95_000);
});
