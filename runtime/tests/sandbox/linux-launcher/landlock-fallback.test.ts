import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { planLandlockConfinement } from "../../../src/sandbox/linux-launcher/landlock-exec.js";
import { runLinuxSandboxMain } from "../../../src/sandbox/linux-launcher/linux-run-main.js";
import {
  restrictedFileSystemPolicy,
  type PermissionProfile,
} from "../../../src/sandbox/engine/index.js";
import { probeLandlock } from "../../../src/sandbox/landlock-run.js";

const canRunLive = process.platform === "linux" && probeLandlock() === "full";

const work: string[] = [];
afterAll(() => {
  for (const dir of work) fs.rmSync(dir, { recursive: true, force: true });
});

function withTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  work.push(dir);
  return dir;
}

function workspaceWriteProfile(
  workspace: string,
  network: PermissionProfile["network"],
): PermissionProfile {
  // Mirrors the production workspace_write shape: full disk read plus a
  // writable workspace, with platform defaults on.
  return {
    fileSystem: restrictedFileSystemPolicy(
      [
        { path: { kind: "special", value: { kind: "root" } }, access: "read" },
        { path: { kind: "path", path: workspace }, access: "write" },
      ],
      { includePlatformDefaults: true },
    ),
    network,
  };
}

/** Run the REAL helper main with bubblewrap made unavailable. */
async function runFallback(
  profile: PermissionProfile,
  workspace: string,
  command: readonly string[],
): Promise<{ exitCode: number; stderr: string[] }> {
  const stderr: string[] = [];
  const exitCode = await runLinuxSandboxMain(
    [
      "--sandbox-policy-cwd",
      workspace,
      "--command-cwd",
      workspace,
      "--permission-profile",
      JSON.stringify(profile),
      "--session-temp-root",
      workspace,
      "--",
      ...command,
    ],
    {
      preferredLauncher: () => null,
      onStderr: (line) => stderr.push(line),
    },
  );
  return { exitCode, stderr };
}

describe("planLandlockConfinement refusals", () => {
  const base = {
    sandboxPolicyCwd: "/tmp",
    sessionTempRoot: "/tmp/agenc-landlock-session-root",
    allowNetworkForProxy: false,
    inheritedCwd: false,
  } as const;
  const plainPolicy = restrictedFileSystemPolicy([
    { path: { kind: "path", path: "/tmp" }, access: "write" },
  ]);

  it("accepts the plugin MCP profile shape (root read + data-dir writes)", () => {
    // The tight plugin-server profile: no writable project root, so no
    // existing .git/.agenc carve-outs — the fallback must express it, which
    // is what keeps plugin MCP servers working on bubblewrap-less hosts.
    const dataDir = withTempDir("agenc-landlock-plan-plugindata-");
    fs.mkdirSync(path.join(dataDir, "tmp"));
    const plan = planLandlockConfinement({
      ...base,
      fileSystem: restrictedFileSystemPolicy(
        [
          {
            path: { kind: "special", value: { kind: "root" } },
            access: "read",
          },
          { path: { kind: "path", path: dataDir }, access: "write" },
          {
            path: { kind: "path", path: path.join(dataDir, "tmp") },
            access: "write",
          },
        ],
        { includePlatformDefaults: true },
      ),
    });
    expect(plan).toMatchObject({
      kind: "ok",
      readWrite: expect.arrayContaining([dataDir]),
    });
  });

  it("still refuses the workspace profile over an existing .agenc (regression guard)", () => {
    const project = withTempDir("agenc-landlock-plan-project-");
    fs.mkdirSync(path.join(project, ".agenc"));
    const plan = planLandlockConfinement({
      ...base,
      sandboxPolicyCwd: project,
      fileSystem: restrictedFileSystemPolicy(
        [
          {
            path: { kind: "special", value: { kind: "root" } },
            access: "read",
          },
          {
            path: { kind: "special", value: { kind: "project_roots" } },
            access: "write",
          },
        ],
        { includePlatformDefaults: true },
      ),
    });
    expect(plan).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining(".agenc"),
    });
  });

  it("refuses managed proxy networking", () => {
    const plan = planLandlockConfinement({
      ...base,
      allowNetworkForProxy: true,
      fileSystem: plainPolicy,
    });
    expect(plan).toMatchObject({ kind: "refused" });
  });

  it("accepts an inherited cwd only after writable roots are removed", () => {
    const refused = planLandlockConfinement({
      ...base,
      inheritedCwd: true,
      fileSystem: plainPolicy,
    });
    expect(refused).toEqual({
      kind: "refused",
      reason: "inherited read-only cwd cannot retain writable filesystem roots",
    });

    const accepted = planLandlockConfinement({
      ...base,
      inheritedCwd: true,
      fileSystem: restrictedFileSystemPolicy(
        [
          {
            path: { kind: "special", value: { kind: "root" } },
            access: "read",
          },
        ],
        { includePlatformDefaults: true },
      ),
    });
    expect(accepted).toMatchObject({
      kind: "ok",
      readWrite: expect.not.arrayContaining(["/tmp"]),
    });
  });

  it("refuses unreadable masks an allow-list cannot express", () => {
    const secret = withTempDir("agenc-landlock-plan-secret-");
    const plan = planLandlockConfinement({
      ...base,
      fileSystem: restrictedFileSystemPolicy([
        { path: { kind: "path", path: "/tmp" }, access: "write" },
        { path: { kind: "path", path: secret }, access: "none" },
      ]),
    });
    expect(plan).toMatchObject({ kind: "refused" });
    expect((plan as { reason: string }).reason).toContain("allow-list");
  });

  it("refuses read-only carve-outs inside a writable root", () => {
    const workspace = withTempDir("agenc-landlock-plan-carveout-");
    const frozen = path.join(workspace, "frozen");
    fs.mkdirSync(frozen);
    const plan = planLandlockConfinement({
      ...base,
      sandboxPolicyCwd: workspace,
      fileSystem: restrictedFileSystemPolicy([
        { path: { kind: "path", path: workspace }, access: "write" },
        { path: { kind: "path", path: frozen }, access: "read" },
      ]),
    });
    expect(plan).toMatchObject({ kind: "refused" });
  });

  it("never grants /proc or /sys, even under full disk read", () => {
    const plan = planLandlockConfinement({
      ...base,
      fileSystem: restrictedFileSystemPolicy(
        [
          {
            path: { kind: "special", value: { kind: "root" } },
            access: "read",
          },
          { path: { kind: "path", path: "/tmp" }, access: "write" },
        ],
        { includePlatformDefaults: true },
      ),
    });
    expect(plan.kind).toBe("ok");
    const grants = plan as { readOnly: readonly string[] };
    expect(grants.readOnly).not.toContain("/proc");
    expect(grants.readOnly).not.toContain("/sys");
    expect(grants.readOnly.length).toBeGreaterThan(0);
  });
});

describe.runIf(canRunLive)("Landlock fallback through the real helper", () => {
  it("leaves the network open when the policy enables it", async () => {
    const workspace = withTempDir("agenc-landlock-fallback-neton-");
    if (!fs.existsSync("/usr/bin/python3")) return;
    const verdict = path.join(workspace, "net.txt");
    const probe = await runFallback(
      workspaceWriteProfile(workspace, "enabled"),
      workspace,
      [
        "/usr/bin/python3",
        "-c",
        "import socket; socket.socket(socket.AF_INET)\n" +
          "open(" +
          JSON.stringify(verdict) +
          ", 'w').write('inet-open')",
      ],
    );
    expect(probe.exitCode).toBe(0);
    expect(fs.readFileSync(verdict, "utf8")).toBe("inet-open");
  });

  it("fails closed with both reasons when the policy is inexpressible", async () => {
    const workspace = withTempDir("agenc-landlock-fallback-refuse-");
    const secret = withTempDir("agenc-landlock-fallback-secret-");
    const result = await runFallback(
      {
        fileSystem: restrictedFileSystemPolicy([
          { path: { kind: "path", path: workspace }, access: "write" },
          { path: { kind: "path", path: secret }, access: "none" },
        ]),
        network: "disabled",
      },
      workspace,
      ["/bin/true"],
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.join("\n")).toContain(
      "Landlock fallback cannot express",
    );
  });
});

describe.runIf(canRunLive)("broker probe fallback", () => {
  it("reports ready through Landlock when bubblewrap is missing from PATH", async () => {
    const { probeSandboxExecutionStatus } =
      await import("../../../src/sandbox/execution-broker.js");
    const cwd = withTempDir("agenc-landlock-probe-cwd-");
    const status = probeSandboxExecutionStatus({
      mode: "workspace_write",
      cwd,
      env: { PATH: "/nonexistent-path-for-probe" },
      platform: "linux",
      agencLinuxSandboxExe: path.resolve(
        __dirname,
        "../../../bin/agenc-linux-sandbox",
      ),
    });
    expect(status.kind).toBe("ready");
    expect(status.landlock).toBe("full");
    expect(status.reason).toContain("Landlock fallback is active");
    expect(status.isolationProgram).toBeDefined();
  });
});
