import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { bootstrapLocalRuntimeSession } from "../../src/bin/bootstrap.js";

describe("production sandbox startup boundary", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("fails before provider setup when required isolation is unavailable", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-startup-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-startup-workspace-"));
    roots.push(home, workspace);

    await expect(
      bootstrapLocalRuntimeSession({
        cwd: workspace,
        env: {
          AGENC_HOME: home,
          HOME: home,
          PATH: join(workspace, "untrusted-bin"),
        },
        argv: ["node", "agenc"],
        requireSandboxReadyAtStartup: true,
      }),
    ).rejects.toMatchObject({
      code: "sandbox_required_unavailable",
      surface: "startup",
      status: {
        kind: "unavailable",
        reason: expect.stringContaining("bubblewrap"),
        remediation: expect.stringContaining("Install bubblewrap"),
      },
    });
  });
});
