import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeMissingExitCode, runSecureStorageCommand } from "../../../src/utils/secureStorage/subprocess.js";

describe("secure storage subprocess runner", () => {
  it("names why a child produced no exit code", () => {
    expect(describeMissingExitCode({ signal: "SIGKILL" })).toBe("signal SIGKILL");
    expect(describeMissingExitCode({ code: "ENOENT", originalMessage: "spawnSync helper ENOENT" })).toBe(
      "spawn error ENOENT; spawnSync helper ENOENT",
    );
    expect(describeMissingExitCode({ isMaxBuffer: true, timedOut: true })).toBe(
      "output exceeded the buffer limit; timed out",
    );
    expect(describeMissingExitCode({})).toBe("no exit code and no error reported");
  });

  it("reports the spawn failure instead of a bare undefined exit code", () => {
    const result = runSecureStorageCommand("/nonexistent/agenc-helper", ["read"], { reject: false });
    expect(result.exitCode).toBeUndefined();
    expect(result.failure).toContain("ENOENT");
  });

  it("still runs the helper when the process's own working directory is gone", () => {
    const doomed = mkdtempSync(join(tmpdir(), "agenc-dead-cwd-"));
    const script = `import { rmSync } from "node:fs";
      import { runSecureStorageCommand } from ${JSON.stringify(new URL("../../../src/utils/secureStorage/subprocess.ts", import.meta.url).href)};
      process.chdir(process.argv[1]);
      rmSync(process.argv[1], { recursive: true, force: true });
      const result = runSecureStorageCommand("/bin/echo", ["still here"], { reject: false, stdio: ["ignore", "pipe", "pipe"] });
      console.log(JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout, failure: result.failure }));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, doomed], { encoding: "utf8" });
    rmSync(doomed, { recursive: true, force: true });
    expect(child.status, child.stderr).toBe(0);
    const parsed = JSON.parse(child.stdout.trim());
    expect(parsed).toMatchObject({ exitCode: 0, stdout: "still here" });
  });
});
