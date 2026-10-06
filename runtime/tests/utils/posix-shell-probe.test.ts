import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Git Bash is the only shell most Windows machines have, and starting one goes
 * through msys2's process emulation. A plain `echo` measured 2,045 ms on an
 * ordinary Windows 11 machine with Git for Windows installed, so a one second
 * probe reported no suitable shell on a machine that had one, and the reader
 * could not tell that from never having installed Git.
 *
 * The probe spawns a real shell, so this reads the bound rather than measuring
 * it: what matters is that Windows is not held to the native figure.
 */

const source = readFileSync(
  join(import.meta.dirname, "../../src/utils/shell/posixShellPath.ts"),
  "utf8",
);

describe("how long a shell gets to answer", () => {
  it("is longer on Windows than a native shell needs", () => {
    const match = /const PROBE_TIMEOUT_MS =\s*process\.platform === "win32" \? ([\d_]+) : ([\d_]+);/.exec(
      source,
    );
    expect(match).not.toBeNull();
    const windows = Number(match![1]!.replaceAll("_", ""));
    const native = Number(match![2]!.replaceAll("_", ""));
    // Comfortably above the measured 2,045 ms, and still bounded.
    expect(windows).toBeGreaterThanOrEqual(5_000);
    expect(windows).toBeLessThanOrEqual(30_000);
    expect(windows).toBeGreaterThan(native);
  });

  it("still tells the reader the bound it applied", () => {
    expect(source).toContain("did not answer within ${PROBE_TIMEOUT_MS} ms");
  });
});
