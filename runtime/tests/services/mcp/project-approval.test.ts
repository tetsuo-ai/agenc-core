import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveHomeContext } from "../../../src/config/home.js";
import type { CanonicalSettingsAuthority } from "../../../src/utils/settings/canonicalAuthority.js";

import {
  approveProjectMcpServerSync,
  rejectProjectMcpServerSync,
  trustedProjectsPath,
} from "../../../src/permissions/trust/project-trust.js";
import type { ScopedMcpServerConfig } from "../../../src/services/mcp/types.js";
import {
  getProjectMcpServerStatus,
  projectMcpServerApprovalDigest,
} from "../../../src/services/mcp/utils.js";

const server: ScopedMcpServerConfig = {
  scope: "project",
  command: "node",
  args: ["safe-server.js"],
};

describe("project MCP content-addressed approval", () => {
  let home = "";
  let previousHome: string | undefined;
  let authority: CanonicalSettingsAuthority;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-project-mcp-approval-"));
    previousHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = home;
    authority = {
      homeContext: resolveHomeContext({ AGENC_HOME: home, HOME: home }),
      projectRoot: process.cwd(),
    } as CanonicalSettingsAuthority;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.AGENC_HOME;
    else process.env.AGENC_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("approves only the exact definition in the canonical trust ledger", () => {
    const digest = projectMcpServerApprovalDigest(server);
    approveProjectMcpServerSync("evil", digest);

    expect(getProjectMcpServerStatus(authority, "evil", server)).toBe("approved");
    expect(
      getProjectMcpServerStatus(authority, "evil", {
        ...server,
        args: ["-e", "require('child_process').execSync('rm -rf /tmp/x')"],
      }),
    ).toBe("pending");
    expect(getProjectMcpServerStatus(authority, "evil")).toBe("pending");

    const ledger = JSON.parse(
      readFileSync(trustedProjectsPath({ agencHome: home }), "utf8"),
    ) as { projectMcpServerChoices?: unknown };
    expect(ledger.projectMcpServerChoices).toEqual([
      expect.objectContaining({
        approvedServerDigests: { evil: digest },
      }),
    ]);
  });

  test("an explicit rejection wins over and removes a matching digest", () => {
    const digest = projectMcpServerApprovalDigest(server);
    approveProjectMcpServerSync("evil", digest);
    rejectProjectMcpServerSync("evil");

    expect(getProjectMcpServerStatus(authority, "evil", server)).toBe("rejected");
    const ledger = JSON.parse(
      readFileSync(trustedProjectsPath({ agencHome: home }), "utf8"),
    ) as {
      projectMcpServerChoices: Array<{
        approvedServerDigests?: Record<string, string>;
        rejectedServers?: string[];
      }>;
    };
    expect(ledger.projectMcpServerChoices[0]?.approvedServerDigests).toBeUndefined();
    expect(ledger.projectMcpServerChoices[0]?.rejectedServers).toEqual(["evil"]);
  });

  test("digest is deterministic across object key order", () => {
    const reordered = {
      args: ["safe-server.js"],
      command: "node",
      scope: "project",
    } as ScopedMcpServerConfig;
    expect(projectMcpServerApprovalDigest(reordered)).toBe(
      projectMcpServerApprovalDigest(server),
    );
  });
});
