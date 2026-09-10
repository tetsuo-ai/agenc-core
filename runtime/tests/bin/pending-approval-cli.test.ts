import { describe, expect, it, vi } from "vitest";
import type { AgenCJsonLineDaemonRequestClient } from "../../src/app-server/agent-cli.js";
import { runAgenCRunCli } from "../../src/bin/run-cli.js";
import { formatAgenCPermissionGrantList, parseAgenCPermissionsCliArgs, runAgenCPermissionsCli } from "../../src/permissions/permission-cli.js";

function captureOutput() {
  const chunks: string[] = [];
  return {
    io: {
      stdout: { write: (value: string | Uint8Array) => { chunks.push(String(value)); return true; } },
      stderr: { write: () => true },
    },
    text: () => chunks.join(""),
  };
}

const pendingRequest = {
  requestId: "approval-1",
  ownerRunId: "workflow-root",
  sessionId: "child-session",
  toolName: "FileWrite",
  input: { file_path: "src/main.ts", content: "replacement" },
  reason: "Write needs approval",
};

describe("pending approval CLI projections", () => {
  it("prints pending requests without pretending they are grants and targets their owner", async () => {
    const response = { permissions: [], pendingRequests: [pendingRequest] };
    const text = formatAgenCPermissionGrantList(response);
    expect(text).toContain("Pending approvals (1)");
    expect(text).toContain("child-session");
    expect(text).toContain("src/main.ts");
    expect(text).toContain("Write needs approval");
    expect(text).toContain("agenc permissions approve --session workflow-root --scope once approval-1");
    expect(text).toContain("agenc permissions revoke --session workflow-root approval-1");
    const approve = parseAgenCPermissionsCliArgs(text.split("\n").find((line) => line.startsWith("agenc permissions approve"))!.split(" ").slice(1));
    expect(approve).toMatchObject({ kind: "approveRequest", sessionId: "workflow-root", requestId: "approval-1", scope: "once" });
    const output = captureOutput();
    await runAgenCPermissionsCli({ kind: "list", target: { kind: "session", sessionId: "workflow-root" }, json: true }, {
      io: output.io,
      ensureDaemonReady: async () => {},
      client: {
        listPermissions: async () => response,
        approveTool: vi.fn(),
        revokeTool: vi.fn(),
      },
    });
    expect(JSON.parse(output.text())).toEqual(response);
  });

  it("prints the effective mode and waiting request in workflow status", async () => {
    const output = captureOutput();
    const request = vi.fn(async () => ({
      runId: "workflow-root", status: "running", terminal: false,
      workflow: { steps: [], effectivePermissionMode: "default" },
      pendingRequests: [pendingRequest],
    }));
    expect(await runAgenCRunCli({ kind: "status", runId: "workflow-root" }, {
      io: output.io, ensureDaemonReady: async () => {},
      client: { request } as unknown as AgenCJsonLineDaemonRequestClient,
    })).toBe(0);
    expect(output.text()).toContain("permission mode: default");
    expect(output.text()).toContain("waiting for approval");
    expect(output.text()).toContain("--session workflow-root --scope once approval-1");
  });

  it("shows a live follow approval once, then observes settlement without auto-approving", async () => {
    const output = captureOutput();
    let statusReads = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "run.start") return {
        runId: "workflow-root", specDigest: "digest", baseCommit: "base",
        baseDirty: { dirty: false, fileCount: 0 }, effectivePermissionMode: "default",
      };
      if (method === "run.replay") return { events: [], nextAfterSequence: 0, hasMore: false };
      if (method === "run.status") {
        statusReads += 1;
        return {
          runId: "workflow-root", status: statusReads < 4 ? "running" : "completed", terminal: statusReads === 4,
          workflow: { steps: [], effectivePermissionMode: "default" },
          pendingRequests: statusReads < 3 ? [pendingRequest] : [],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const sleep = vi.fn(async () => {
      if (statusReads === 1) {
        expect(output.text()).toContain("permission mode: default");
        expect(output.text()).toContain("agenc permissions approve --session workflow-root --scope once approval-1");
      }
    });
    expect(await runAgenCRunCli({ kind: "start", goal: "fix", verify: [], follow: true }, {
      io: output.io, ensureDaemonReady: async () => {}, sleep,
      client: { request } as unknown as AgenCJsonLineDaemonRequestClient,
    })).toBe(0);
    expect(output.text().match(/agenc permissions approve/g)).toHaveLength(1);
    expect(output.text()).toContain("no pending approvals");
    expect(output.text()).toContain("terminal: completed");
    expect(request.mock.calls.every(([method]) => ["run.start", "run.replay", "run.status"].includes(method))).toBe(true);
  });

  it("escapes terminal controls and never emits an executable command for unsafe IDs", () => {
    const text = formatAgenCPermissionGrantList({ permissions: [], pendingRequests: [{
      ...pendingRequest,
      ownerRunId: "owner; unwanted",
      requestId: "request\nsecond-line",
      reason: "\u001b[2Jhidden",
    }] });
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("request\nsecond-line");
    expect(text).toContain("owner; unwanted");
    expect(text).not.toContain("agenc permissions approve --session owner;");
  });
});
