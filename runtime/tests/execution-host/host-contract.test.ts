import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("qualifies the host lease, ownership, replay and private protocol contracts", () => {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  const result = spawnSync("/usr/bin/python3", [
    "-I", "-B", "-m", "unittest", "discover", "-s", directory, "-v",
  ], {
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toMatch(/Ran [1-9]\d* tests/);
  expect(result.stderr).not.toMatch(/skipped=/);
}, 35_000);
