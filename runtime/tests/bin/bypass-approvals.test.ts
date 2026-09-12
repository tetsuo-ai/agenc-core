import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resetStartupSandboxBypassNoticeForTests,
  resolveStartupSandboxBypass,
  sandboxUnavailableNotice,
  writeStartupSandboxBypassNotice,
} from "../../src/bin/bypass-approvals.js";
import { classifyCLI, stripRoutingFlags } from "../../src/bin/route.js";
import type { SandboxExecutionStatus } from "../../src/sandbox/execution-broker.js";

const executable = ["/usr/bin/node", "/opt/agenc/agenc.js"];

function status(
  kind: SandboxExecutionStatus["kind"],
  reason?: string,
): SandboxExecutionStatus {
  return {
    kind,
    mode: "workspace_write",
    platform: "darwin",
    ...(reason !== undefined ? { reason } : {}),
  };
}

describe("--bypass-approvals routing", () => {
  it("is a startup flag, not prompt text, in print mode", () => {
    expect(
      classifyCLI({
        argv: [...executable, "--bypass-approvals", "-p", "explain the repo"],
        isTTY: false,
        isStdoutTTY: false,
      }),
    ).toMatchObject({ kind: "oneShotCLI", userMessage: "explain the repo" });
    expect(
      stripRoutingFlags(["--bypass-approvals", "-p", "explain the repo"]),
    ).toEqual(["explain the repo"]);
  });

  it("boots the TUI when no prompt is given", () => {
    expect(
      classifyCLI({
        argv: [...executable, "--bypass-approvals"],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toMatchObject({ kind: "bootTUI" });
  });
});

describe("resolveStartupSandboxBypass", () => {
  afterEach(() => {
    resetStartupSandboxBypassNoticeForTests();
  });

  it("keeps the configured sandbox when neither bypass flag is set", () => {
    const probe = vi.fn(() => status("ready"));
    expect(
      resolveStartupSandboxBypass({}, { cwd: "/tmp", env: {}, probe }),
    ).toEqual({ dangerouslyBypassApprovalsAndSandbox: false });
    expect(probe).not.toHaveBeenCalled();
  });

  it("drops the sandbox without probing for the dangerous flag", () => {
    const probe = vi.fn(() => status("ready"));
    expect(
      resolveStartupSandboxBypass(
        { dangerouslyBypassApprovalsAndSandbox: true, bypassApprovals: true },
        { cwd: "/tmp", env: {}, probe },
      ),
    ).toEqual({ dangerouslyBypassApprovalsAndSandbox: true });
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(["ready", "not_required", "external"] as const)(
    "keeps the sandbox for --bypass-approvals when the host reports %s",
    (kind) => {
      const probe = vi.fn(() => status(kind));
      const resolution = resolveStartupSandboxBypass(
        { bypassApprovals: true },
        { cwd: "/repo", env: { PATH: "/usr/bin" }, platform: "linux", probe },
      );
      expect(resolution).toEqual({ dangerouslyBypassApprovalsAndSandbox: false });
      expect(probe).toHaveBeenCalledWith({
        cwd: "/repo",
        env: { PATH: "/usr/bin" },
        platform: "linux",
      });
    },
  );

  it("falls back to full access with a notice when the host cannot sandbox", () => {
    const unavailable = status(
      "unavailable",
      "Windows restricted-token sandbox is not implemented",
    );
    const resolution = resolveStartupSandboxBypass(
      { bypassApprovals: true },
      { cwd: "/repo", env: {}, platform: "win32", probe: () => unavailable },
    );
    expect(resolution.dangerouslyBypassApprovalsAndSandbox).toBe(true);
    expect(resolution.notice).toBe(sandboxUnavailableNotice(unavailable));
    expect(resolution.notice).toContain("--bypass-approvals");
    expect(resolution.notice).toContain(
      "Windows restricted-token sandbox is not implemented",
    );
    expect(resolution.notice).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(resolution.notice).not.toContain("\u2014");
  });

  it("writes the notice once per process and nothing when there is none", () => {
    const writes: string[] = [];
    const stderr = { write: (chunk: string) => writes.push(chunk) };
    writeStartupSandboxBypassNotice(
      { dangerouslyBypassApprovalsAndSandbox: false },
      stderr,
    );
    expect(writes).toEqual([]);
    const resolution = {
      dangerouslyBypassApprovalsAndSandbox: true,
      notice: "agenc: --bypass-approvals: the OS sandbox is unavailable on this host (x)",
    };
    writeStartupSandboxBypassNotice(resolution, stderr);
    writeStartupSandboxBypassNotice(resolution, stderr);
    expect(writes).toEqual([`${resolution.notice}\n`]);
  });
});
