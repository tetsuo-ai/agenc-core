import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const { readGatewayCredentialSnapshotMock } = vi.hoisted(() => ({
  readGatewayCredentialSnapshotMock: vi.fn(() => ({
    environment: Object.freeze({
      AGENC_HOOKS_TOKEN: "stored-environment-token",
    }),
    generatedTokens: Object.freeze({ hooks: "stored-generated-token" }),
  })),
}));

vi.mock("../../src/gateway/credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gateway/credentials.js")>()),
  readGatewayCredentialSnapshot: readGatewayCredentialSnapshotMock,
}));

import { buildSecurityAuditReport } from "../../src/bin/security-cli.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  readGatewayCredentialSnapshotMock.mockClear();
});

describe("security audit native secure-storage ownership", () => {
  test("reads one canonical gateway snapshot per report", async () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-security-snapshot-"));
    roots.push(home);
    writeFileSync(
      join(home, "config.toml"),
      "config_version = 2\n[gateway.hooks]\nenabled = true\n",
      { mode: 0o600 },
    );

    await expect(
      buildSecurityAuditReport({ env: { AGENC_HOME: home, HOME: home } }),
    ).resolves.toMatchObject({ agencHome: home });

    expect(readGatewayCredentialSnapshotMock).toHaveBeenCalledTimes(1);
    expect(readGatewayCredentialSnapshotMock.mock.calls[0]?.[0]).toMatchObject({
      path: home,
    });
  });

  test("leaves native secure storage unopened during the daemon startup audit", async () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-security-startup-"));
    roots.push(home);
    writeFileSync(
      join(home, "config.toml"),
      "config_version = 2\n[gateway.hooks]\nenabled = true\n",
      { mode: 0o600 },
    );

    const report = await buildSecurityAuditReport({
      env: { AGENC_HOME: home, HOME: home },
      inspectNativeCredentials: false,
    });

    expect(readGatewayCredentialSnapshotMock).not.toHaveBeenCalled();
    expect(
      report.findings.find(
        (finding) => finding.id === "hooks-exposure:credential-inspection",
      ),
    ).toMatchObject({ severity: "warn" });
    expect(report.criticalCount).toBe(0);
  });
});
