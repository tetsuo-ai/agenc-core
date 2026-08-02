import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const probeMocks = vi.hoisted(() => ({
  findBubblewrap: vi.fn(),
  spawnSync: vi.fn(),
  supportsDescriptorBind: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: probeMocks.spawnSync,
  };
});

vi.mock("../../src/sandbox/linux-launcher/launcher.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/sandbox/linux-launcher/launcher.js")
    >();
  return {
    ...actual,
    findSystemBubblewrapInPath: probeMocks.findBubblewrap,
    systemBubblewrapSupportsBindFd: probeMocks.supportsDescriptorBind,
  };
});

import { probeSandboxExecutionStatus } from "../../src/sandbox/execution-broker.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  probeMocks.findBubblewrap.mockReset();
  probeMocks.spawnSync.mockReset();
  probeMocks.supportsDescriptorBind.mockReset();
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { force: true, recursive: true });
  }
});

describe("Linux sandbox bubblewrap readiness", () => {
  it.runIf(process.platform !== "win32")(
    "fails before the namespace probe when descriptor binds are unavailable",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agenc-sandbox-bind-fd-"));
      temporaryRoots.push(root);
      const workspace = join(root, "workspace");
      const helper = join(root, "agenc-linux-sandbox");
      const bwrap = "/opt/agenc-test/old-bwrap";
      const env = { PATH: "/usr/bin" };
      mkdirSync(workspace);
      writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      probeMocks.findBubblewrap.mockReturnValue(bwrap);
      probeMocks.supportsDescriptorBind.mockReturnValue(false);
      probeMocks.spawnSync.mockReturnValue({
        error: undefined,
        status: 0,
        stderr: "",
      });

      const status = probeSandboxExecutionStatus({
        mode: "workspace_write",
        cwd: workspace,
        env,
        platform: "linux",
        agencLinuxSandboxExe: helper,
      });

      expect(status).toEqual({
        kind: "unavailable",
        mode: "workspace_write",
        platform: "linux",
        reason: "bubblewrap does not support descriptor-based read-only binds",
        remediation:
          "Upgrade bubblewrap to a version that supports --ro-bind-fd, then run `agenc doctor` again.",
        helperPath: realpathSync(helper),
        isolationProgram: bwrap,
      });
      expect(probeMocks.findBubblewrap).toHaveBeenCalledWith(
        env.PATH,
        workspace,
      );
      expect(probeMocks.supportsDescriptorBind).toHaveBeenCalledWith(
        bwrap,
        env,
      );
      expect(probeMocks.spawnSync).not.toHaveBeenCalled();
    },
  );
});
