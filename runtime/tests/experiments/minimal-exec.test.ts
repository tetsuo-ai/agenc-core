import { expect, test } from "vitest";
import { minimalExec } from "../../src/unified-exec/minimal-exec.js";

test("foreground probe captures stdout, stderr and nonzero exit without inventing output", async () => {
  const result = await minimalExec({ cmd: "printf 'out'; printf 'err' >&2; exit 7" },
    process.cwd(), "/bin/bash", { PATH: "/usr/bin:/bin" });
  expect(result).toMatchObject({ stdout: "out", stderr: "err", exitCode: 7, exit_code: 7, truncated: false });
  expect(result.output).toContain("out");
  expect(result.output).toContain("err");
});

test("foreground probe rejects spawn failures and pre-aborted commands", async () => {
  await expect(minimalExec({ cmd: "true", shell: "/nonexistent-shell" }, process.cwd(), "/bin/bash", {})).rejects.toThrow();
  const controller = new AbortController();
  controller.abort(new Error("cancelled before spawn"));
  await expect(minimalExec({ cmd: "true", __abortSignal: controller.signal }, process.cwd(), "/bin/bash", {})).rejects.toThrow("cancelled before spawn");
});
