import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { parsePowerShellCommandWithSandbox } from "../../src/utils/powershell/parser.js";
import { resetPowerShellCache } from "../../src/utils/shell/powershellDetection.js";

describe("PowerShell parser process sandbox closure", () => {
  let root = "";
  let marker = "";
  let savedPath: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-pwsh-boundary-"));
    marker = join(root, "spawned");
    const executable = join(root, "pwsh");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf spawned > "${marker}"\nexit 1\n`,
      "utf8",
    );
    await chmod(executable, 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${root}${delimiter}${savedPath ?? ""}`;
    resetPowerShellCache();
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    resetPowerShellCache();
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  test("unavailable isolation blocks the native parser before spawn", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: root,
      platform: "linux",
      probe: () => ({
        kind: "unavailable",
        mode: "workspace_write",
        platform: "linux",
        reason: "probe: forced unavailable for PowerShell parser test",
        remediation: "repair the test sandbox",
      }),
    });

    await expect(
      parsePowerShellCommandWithSandbox("Get-ChildItem", broker, root),
    ).rejects.toMatchObject({
      code: "sandbox_probe_failed",
      surface: "powershell_parser",
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
