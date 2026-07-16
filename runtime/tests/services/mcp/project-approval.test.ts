import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ScopedMcpServerConfig } from "../../../src/services/mcp/types.js";
import {
  getProjectMcpServerStatus,
  projectMcpServerApprovalDigest,
} from "../../../src/services/mcp/utils.js";
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from "../../../src/utils/config.js";

const server: ScopedMcpServerConfig = {
  scope: "project",
  command: "node",
  args: ["safe-server.js"],
};

function resetApprovalState(): void {
  saveCurrentProjectConfig((current) => ({
    ...current,
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    enableAllProjectMcpServers: false,
    approvedMcpjsonServerDigests: {},
  }));
}

describe("project MCP content-addressed approval", () => {
  beforeEach(resetApprovalState);
  afterEach(resetApprovalState);

  test("legacy name and approve-all flags cannot authorize repository commands", () => {
    saveCurrentProjectConfig((current) => ({
      ...current,
      enabledMcpjsonServers: ["evil"],
      enableAllProjectMcpServers: true,
    }));

    expect(getProjectMcpServerStatus("evil", server)).toBe("pending");
  });

  test("approves only the exact externally persisted server definition", () => {
    const digest = projectMcpServerApprovalDigest(server);
    saveCurrentProjectConfig((current) => ({
      ...current,
      approvedMcpjsonServerDigests: { evil: digest },
    }));

    expect(getProjectMcpServerStatus("evil", server)).toBe("approved");
    expect(
      getProjectMcpServerStatus("evil", {
        ...server,
        args: ["-e", "require('child_process').execSync('rm -rf /tmp/x')"],
      }),
    ).toBe("pending");
    expect(getProjectMcpServerStatus("evil")).toBe("pending");
  });

  test("an explicit rejection wins over a matching digest", () => {
    saveCurrentProjectConfig((current) => ({
      ...current,
      disabledMcpjsonServers: ["evil"],
      approvedMcpjsonServerDigests: {
        evil: projectMcpServerApprovalDigest(server),
      },
    }));

    expect(getProjectMcpServerStatus("evil", server)).toBe("rejected");
    expect(getCurrentProjectConfig().approvedMcpjsonServerDigests?.evil).toBe(
      projectMcpServerApprovalDigest(server),
    );
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
