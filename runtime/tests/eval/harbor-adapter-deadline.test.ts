import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Harbor adapter's budget -> `--deadline` derivation (#2503) is Python;
 * run its unittest suite so the hermetic suite covers it. The adapter-level
 * cases skip themselves when this Python has no Harbor package.
 */
const harborDir = join(dirname(fileURLToPath(import.meta.url)), "../../eval/harbor");

function python(): string | null {
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["-c", "import sys, tomllib; sys.exit(0)"], {
      encoding: "utf8",
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

describe("Harbor adapter deadline derivation", () => {
  const interpreter = python();

  it.skipIf(interpreter === null)("passes its unittest suite", () => {
    const result = spawnSync(
      interpreter!,
      ["-m", "unittest", "discover", "-s", harborDir, "-p", "test_*.py"],
      { encoding: "utf8", cwd: harborDir },
    );
    expect(result.stderr).toMatch(/^OK/m);
    expect(result.status, result.stderr).toBe(0);
  });
});
