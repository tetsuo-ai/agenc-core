import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  SandboxExecutionBroker,
  attachSandboxExecutionBroker,
} from "../../src/sandbox/execution-broker.js";
import { createBrowserTool } from "../../src/tools/BrowserTool/tool.js";

describe("browser process sandbox closure", () => {
  let root = "";
  let marker = "";
  let executable = "";
  let savedExecutable: string | undefined;
  let savedProfile: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-browser-boundary-"));
    marker = join(root, "spawned");
    executable = join(root, "chromium");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf spawned > "${marker}"\nexit 1\n`,
      "utf8",
    );
    await chmod(executable, 0o755);
    savedExecutable = process.env.AGENC_BROWSER_EXECUTABLE;
    savedProfile = process.env.AGENC_BROWSER_PROFILE_DIR;
    process.env.AGENC_BROWSER_EXECUTABLE = executable;
    process.env.AGENC_BROWSER_PROFILE_DIR = join(root, "profile");
  });

  afterEach(async () => {
    if (savedExecutable === undefined) {
      delete process.env.AGENC_BROWSER_EXECUTABLE;
    } else {
      process.env.AGENC_BROWSER_EXECUTABLE = savedExecutable;
    }
    if (savedProfile === undefined) {
      delete process.env.AGENC_BROWSER_PROFILE_DIR;
    } else {
      process.env.AGENC_BROWSER_PROFILE_DIR = savedProfile;
    }
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  test("model dispatch stops before a configured browser executable can run", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: root,
      platform: "linux",
      probe: () => ({
        kind: "unavailable",
        mode: "workspace_write",
        platform: "linux",
        reason: "probe: forced unavailable for browser boundary test",
        remediation: "repair the test sandbox",
      }),
    });
    const args: Record<string, unknown> = {
      action: "navigate",
      url: "https://example.com",
    };
    attachSandboxExecutionBroker(args, broker, "interactive");

    const result = await createBrowserTool({ agencHome: root }).execute(args);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("sandbox_probe_failed");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
