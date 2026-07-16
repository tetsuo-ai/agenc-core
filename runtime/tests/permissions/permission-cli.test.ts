import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  formatAgenCPermissionGrantList,
  parseAgenCPermissionsCliArgs,
  runAgenCPermissionsCli,
  type AgenCPermissionsCliDaemonClient,
  type AgenCPermissionsCliIo,
} from "./permission-cli.js";

function createIo(): AgenCPermissionsCliIo & {
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

describe("permission CLI parser", () => {
  it("parses list, rule approval, rule revoke, and request resolution forms", () => {
    expect(parseAgenCPermissionsCliArgs(["hello"])).toBeNull();
    expect(parseAgenCPermissionsCliArgs(["permissions"])).toEqual({
      kind: "help",
      text: expect.stringContaining("agenc permissions"),
    });
    expect(parseAgenCPermissionsCliArgs(["permissions", "list", "--help"]))
      .toEqual({
        kind: "help",
        text: expect.stringContaining("Examples:"),
      });
    expect(
      parseAgenCPermissionsCliArgs([
        "permissions",
        "list",
        "--json",
        "--session",
        "session_1",
      ]),
    ).toEqual({
      kind: "list",
      json: true,
      target: { kind: "session", sessionId: "session_1" },
    });
    expect(
      parseAgenCPermissionsCliArgs([
        "permissions",
        "approve",
        "--persist",
        "project",
        "Read",
      ]),
    ).toEqual({
      kind: "error",
      message:
        "repository files cannot store permission approvals; use --persist user or approve a live request with --session",
    });
    expect(
      parseAgenCPermissionsCliArgs(["permissions", "revoke", "Bash(ls)"]),
    ).toEqual({
      kind: "revokeRule",
      destination: "userSettings",
      rule: "Bash(ls)",
    });
    expect(
      parseAgenCPermissionsCliArgs([
        "permissions",
        "approve",
        "--session",
        "session_1",
        "--scope",
        "session",
        "call_1",
      ]),
    ).toEqual({
      kind: "approveRequest",
      sessionId: "session_1",
      requestId: "call_1",
      scope: "session",
    });
    expect(
      parseAgenCPermissionsCliArgs([
        "permissions",
        "revoke",
        "--session=session_1",
        "--reason",
        "outside workspace",
        "call_1",
      ]),
    ).toEqual({
      kind: "revokeRequest",
      sessionId: "session_1",
      requestId: "call_1",
      reason: "outside workspace",
    });
  });

  it("rejects ambiguous and invalid permission arguments", () => {
    expect(
      parseAgenCPermissionsCliArgs([
        "permissions",
        "approve",
        "--session",
        "session_1",
        "--persist",
        "project",
        "Read",
      ]),
    ).toEqual({
      kind: "error",
      message: "permissions approve cannot combine --session and --persist",
    });
    expect(
      parseAgenCPermissionsCliArgs([
        "permissions",
        "revoke",
        "--session",
        "session_1",
        "--persist=user",
        "Read",
      ]),
    ).toEqual({
      kind: "error",
      message: "permissions revoke cannot combine --session and --persist",
    });
    expect(
      parseAgenCPermissionsCliArgs([
        "permissions",
        "approve",
        "--persist",
        "user",
        "--persist",
        "project",
        "Read",
      ]),
    ).toEqual({
      kind: "error",
      message: "permissions approve accepts --persist only once",
    });
    expect(
      parseAgenCPermissionsCliArgs([
        "permissions",
        "approve",
        "--session",
        "session_1",
        "--session",
        "session_2",
        "call_1",
      ]),
    ).toEqual({
      kind: "error",
      message: "permissions approve accepts --session only once",
    });
    expect(
      parseAgenCPermissionsCliArgs([
        "permissions",
        "approve",
        "--session",
        "session_1",
        "--scope",
        "once",
        "--scope",
        "session",
        "call_1",
      ]),
    ).toEqual({
      kind: "error",
      message: "permissions approve accepts --scope only once",
    });
    expect(
      parseAgenCPermissionsCliArgs([
        "permissions",
        "revoke",
        "--session",
        "session_1",
        "--reason",
        "no",
        "--reason",
        "still no",
        "call_1",
      ]),
    ).toEqual({
      kind: "error",
      message: "permissions revoke accepts --reason only once",
    });
    expect(
      parseAgenCPermissionsCliArgs(["permissions", "list", "--agent"]),
    ).toEqual({
      kind: "error",
      message: "permissions list --agent requires an id",
    });
    expect(
      parseAgenCPermissionsCliArgs([
        "permissions",
        "list",
        "--agent",
        "agent_1",
        "--session",
        "session_1",
      ]),
    ).toEqual({
      kind: "error",
      message: "permissions list accepts only one target",
    });
    expect(
      parseAgenCPermissionsCliArgs([
        "permissions",
        "approve",
        "--session",
        "session_1",
        "--scope",
        "forever",
        "call_1",
      ]),
    ).toEqual({
      kind: "error",
      message: "permissions approve --scope must be once, session, or agent",
    });
    expect(
      parseAgenCPermissionsCliArgs([
        "permissions",
        "approve",
        "--reason",
        "no",
        "Read",
      ]),
    ).toEqual({
      kind: "error",
      message: "permissions approve does not accept --reason",
    });
    expect(
      parseAgenCPermissionsCliArgs([
        "permissions",
        "revoke",
        "--scope",
        "session",
        "Read",
      ]),
    ).toEqual({
      kind: "error",
      message: "permissions revoke does not accept --scope",
    });
  });
});

describe("permission CLI local rules", () => {
  it("rejects repository-persisted approvals without mutating the workspace", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agenc-permission-cli-boundary-"));
    try {
      for (const destination of [
        "projectSettings",
        "localSettings",
      ] as const) {
        const io = createIo();
        await expect(
          runAgenCPermissionsCli(
            { kind: "approveRule", rule: "Read", destination },
            { home: tmp, cwd: tmp, io },
          ),
        ).resolves.toBe(1);
        expect(io.stderrText()).toContain(
          "repository files cannot store permission approvals",
        );
      }
      await expect(access(join(tmp, ".agenc", "settings.json"))).rejects.toThrow();
      await expect(
        access(join(tmp, ".agenc", "settings.local.json")),
      ).rejects.toThrow();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("approves, lists, and revokes persisted allow rules", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agenc-permission-cli-"));
    try {
      const io = createIo();
      const auditLogger = vi.fn(async () => {});
      await expect(
        runAgenCPermissionsCli(
          { kind: "approveRule", rule: "Read", destination: "userSettings" },
          { home: tmp, cwd: tmp, io, permissionAuditLogger: auditLogger },
        ),
      ).resolves.toBe(0);
      expect(io.stdoutText()).toBe("Approved Read in userSettings\n");
      const settingsPath = join(tmp, ".agenc", "settings.json");
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
        permissions: { allow: ["Read"] },
      });

      const listIo = createIo();
      await expect(
        runAgenCPermissionsCli(
          { kind: "list", target: null, json: false },
          { home: tmp, cwd: tmp, io: listIo },
        ),
      ).resolves.toBe(0);
      expect(listIo.stdoutText()).toContain("permission-mode");
      expect(listIo.stdoutText()).toContain("Read");
      expect(listIo.stdoutText()).toContain("allow");

      const revokeIo = createIo();
      await expect(
        runAgenCPermissionsCli(
          { kind: "revokeRule", rule: "Read", destination: "userSettings" },
          { home: tmp, cwd: tmp, io: revokeIo, permissionAuditLogger: auditLogger },
        ),
      ).resolves.toBe(0);
      expect(revokeIo.stdoutText()).toBe("Revoked Read from userSettings\n");
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
        permissions: { allow: [] },
      });
      expect(auditLogger).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKind: "rule_change",
          decision: "approved",
          source: "permissions-cli",
          subjectType: "rule",
          rule: "Read",
          destination: "userSettings",
          reasonCode: "local_rule_approved",
        }),
      );
      expect(auditLogger).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKind: "rule_change",
          decision: "revoked",
          source: "permissions-cli",
          subjectType: "rule",
          rule: "Read",
          destination: "userSettings",
          reasonCode: "local_rule_revoked",
        }),
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("tolerates local permission audit logger failures", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agenc-permission-cli-audit-"));
    try {
      const io = createIo();
      const onPermissionAuditError = vi.fn();
      await expect(
        runAgenCPermissionsCli(
          { kind: "approveRule", rule: "Read", destination: "userSettings" },
          {
            home: tmp,
            cwd: tmp,
            io,
            permissionAuditLogger: async () => {
              throw new Error("audit unavailable");
            },
            onPermissionAuditError,
          },
        ),
      ).resolves.toBe(0);
      expect(io.stdoutText()).toBe("Approved Read in userSettings\n");
      expect(onPermissionAuditError).toHaveBeenCalledOnce();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("reports invalid rule syntax without mutating settings", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agenc-permission-cli-invalid-"));
    try {
      await mkdir(join(tmp, ".agenc"), { recursive: true });
      const io = createIo();
      await expect(
        runAgenCPermissionsCli(
          {
            kind: "approveRule",
            rule: "",
            destination: "userSettings",
          },
          { home: tmp, cwd: tmp, io },
        ),
      ).resolves.toBe(1);
      expect(io.stderrText()).toContain("Invalid permission rule");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("permission CLI daemon requests", () => {
  it("lists targeted daemon permissions", async () => {
    const io = createIo();
    const ensureDaemonReady = vi.fn(async () => {});
    const client: AgenCPermissionsCliDaemonClient = {
      listPermissions: vi.fn(async () => ({
        permissions: [
          {
            permissionId: "rule:allow:session:Read",
            subject: "Read",
            action: "allow",
            scope: "session",
          },
        ],
      })),
      approveTool: vi.fn(),
      revokeTool: vi.fn(),
    };

    await expect(
      runAgenCPermissionsCli(
        {
          kind: "list",
          json: false,
          target: { kind: "agent", agentId: "agent_1" },
        },
        { client, ensureDaemonReady, io },
      ),
    ).resolves.toBe(0);

    expect(ensureDaemonReady).toHaveBeenCalledTimes(1);
    expect(client.listPermissions).toHaveBeenCalledWith({ agentId: "agent_1" });
    expect(io.stdoutText()).toContain("rule:allow:session:Read");
    expect(io.stdoutText()).toContain("Read");
  });

  it("approves and revokes live permission requests through the daemon", async () => {
    const io = createIo();
    const ensureDaemonReady = vi.fn(async () => {});
    const client: AgenCPermissionsCliDaemonClient = {
      listPermissions: vi.fn(),
      approveTool: vi.fn(async (params) => ({
        requestId: params.requestId,
        decision: "approved",
      })),
      revokeTool: vi.fn(async (params) => ({
        requestId: params.requestId,
        decision: "denied",
      })),
    };

    await expect(
      runAgenCPermissionsCli(
        {
          kind: "approveRequest",
          sessionId: "session_1",
          requestId: "call_1",
          scope: "session",
        },
        { client, ensureDaemonReady, io },
      ),
    ).resolves.toBe(0);
    await expect(
      runAgenCPermissionsCli(
        {
          kind: "revokeRequest",
          sessionId: "session_1",
          requestId: "call_2",
          reason: "no",
        },
        { client, ensureDaemonReady, io },
      ),
    ).resolves.toBe(0);

    expect(client.approveTool).toHaveBeenCalledWith({
      sessionId: "session_1",
      requestId: "call_1",
      scope: "session",
    });
    expect(client.revokeTool).toHaveBeenCalledWith({
      sessionId: "session_1",
      requestId: "call_2",
      reason: "no",
    });
    expect(io.stdoutText()).toContain("call_1\tapproved");
    expect(io.stdoutText()).toContain("call_2\trevoked");
  });

  it("does not duplicate audit events for targeted daemon request decisions", async () => {
    const io = createIo();
    const auditLogger = vi.fn(async () => {});
    const client: AgenCPermissionsCliDaemonClient = {
      listPermissions: vi.fn(),
      approveTool: vi.fn(async (params) => ({
        requestId: params.requestId,
        decision: "approved",
      })),
      revokeTool: vi.fn(),
    };

    await expect(
      runAgenCPermissionsCli(
        {
          kind: "approveRequest",
          sessionId: "session_1",
          requestId: "call_1",
        },
        {
          client,
          ensureDaemonReady: async () => {},
          io,
          permissionAuditLogger: auditLogger,
        },
      ),
    ).resolves.toBe(0);

    expect(auditLogger).not.toHaveBeenCalled();
  });
});

describe("formatAgenCPermissionGrantList", () => {
  it("formats empty and tabular grant lists", () => {
    expect(formatAgenCPermissionGrantList({ permissions: [] })).toBe(
      "No permissions",
    );
    expect(
      formatAgenCPermissionGrantList({
        permissions: [
          {
            permissionId: "mode:default",
            subject: "permission-mode",
            action: "default",
            scope: "session",
            grantedAt: "2026-05-04T00:00:00.000Z",
          },
        ],
      }),
    ).toContain("mode:default\tpermission-mode\tdefault\tsession");
  });
});
