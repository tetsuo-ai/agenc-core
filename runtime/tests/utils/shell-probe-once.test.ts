import { describe, expect, test, vi } from "vitest";

const probes = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("../../src/utils/shell/posixShellPath.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/shell/posixShellPath.js")>();
  return {
    ...actual,
    probePosixShellPath: (shellPath: string, environment: NodeJS.ProcessEnv) => {
      probes.paths.push(shellPath);
      return actual.probePosixShellPath(shellPath, environment);
    },
  };
});

import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { findSuitableShell } from "../../src/utils/Shell.js";

describe("shell discovery", () => {
  test("probes a supported SHELL once and uses it", async () => {
    if (process.platform === "win32") return;
    probes.paths.length = 0;
    await expect(
      findSuitableShell(resolveAgentRuntimeOptions({}), { SHELL: "/bin/bash" }),
    ).resolves.toBe("/bin/bash");
    expect(probes.paths).toEqual(["/bin/bash"]);
  });

  test("falls back to the fixed locations when SHELL fails its probe", async () => {
    if (process.platform === "win32") return;
    probes.paths.length = 0;
    const shell = await findSuitableShell(resolveAgentRuntimeOptions({}), {
      SHELL: "/nonexistent/bin/bash",
    });
    expect(shell).not.toBe("/nonexistent/bin/bash");
    expect(probes.paths[0]).toBe("/nonexistent/bin/bash");
    expect(probes.paths).toContain(shell);
  });
});
