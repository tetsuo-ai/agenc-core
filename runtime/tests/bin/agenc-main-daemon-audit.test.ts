import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const daemonMocks = vi.hoisted(() => ({
  parse: vi.fn(),
  run: vi.fn(),
}));
const securityMocks = vi.hoisted(() => ({
  buildAudit: vi.fn(),
}));

vi.mock("../../src/app-server/daemon-cli.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/app-server/daemon-cli.js")
  >()),
  parseAgenCDaemonCliArgs: daemonMocks.parse,
  runAgenCDaemonCli: daemonMocks.run,
}));

vi.mock("../../src/bin/security-cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/bin/security-cli.js")>()),
  buildSecurityAuditReport: securityMocks.buildAudit,
}));

import {
  main,
  shouldRunDaemonStartupSecurityAudit,
} from "../../src/bin/agenc-main.js";
import { AGENC_DAEMON_STARTUP_GUARD_ENV } from "../../src/app-server/daemon-startup-guard.js";

const originalArgv = process.argv.slice();
const originalDaemonRun = process.env.AGENC_DAEMON_RUN;
const originalStartupGuard = process.env[AGENC_DAEMON_STARTUP_GUARD_ENV];
const originalProcessSend = Object.getOwnPropertyDescriptor(process, "send");
const startupGuardToken = "a".repeat(32);

describe("daemon startup security audit ownership", () => {
  beforeEach(() => {
    process.argv = [process.execPath, "agenc", "daemon", "start", "--foreground"];
    daemonMocks.parse.mockReturnValue({ kind: "command", action: "run" });
    daemonMocks.run.mockResolvedValue(0);
    securityMocks.buildAudit.mockResolvedValue({ criticalCount: 0 });
  });

  afterEach(() => {
    process.argv = originalArgv.slice();
    if (originalDaemonRun === undefined) delete process.env.AGENC_DAEMON_RUN;
    else process.env.AGENC_DAEMON_RUN = originalDaemonRun;
    if (originalStartupGuard === undefined) {
      delete process.env[AGENC_DAEMON_STARTUP_GUARD_ENV];
    } else {
      process.env[AGENC_DAEMON_STARTUP_GUARD_ENV] = originalStartupGuard;
    }
    if (originalProcessSend === undefined) {
      Reflect.deleteProperty(process, "send");
    } else {
      Object.defineProperty(process, "send", originalProcessSend);
    }
    vi.clearAllMocks();
  });

  it("runs once in the operator process and not again in its detached child", () => {
    expect(shouldRunDaemonStartupSecurityAudit("start", {})).toBe(true);
    expect(
      shouldRunDaemonStartupSecurityAudit("start", { AGENC_DAEMON_RUN: "1" }),
    ).toBe(true);
    expect(shouldRunDaemonStartupSecurityAudit("restart", {})).toBe(true);
    expect(shouldRunDaemonStartupSecurityAudit("run", {})).toBe(true);
    expect(
      shouldRunDaemonStartupSecurityAudit(
        "run",
        {
          AGENC_DAEMON_RUN: "1",
          [AGENC_DAEMON_STARTUP_GUARD_ENV]: startupGuardToken,
        },
        true,
      ),
    ).toBe(false);
    expect(
      shouldRunDaemonStartupSecurityAudit(
        "run",
        { AGENC_DAEMON_RUN: "1" },
        true,
      ),
    ).toBe(true);
    expect(
      shouldRunDaemonStartupSecurityAudit(
        "run",
        {
          AGENC_DAEMON_RUN: "1",
          [AGENC_DAEMON_STARTUP_GUARD_ENV]: startupGuardToken,
        },
        false,
      ),
    ).toBe(true);
    expect(
      shouldRunDaemonStartupSecurityAudit(
        "run",
        {
          AGENC_DAEMON_RUN: "1",
          [AGENC_DAEMON_STARTUP_GUARD_ENV]: "a".repeat(1_025),
        },
        true,
      ),
    ).toBe(true);
    expect(shouldRunDaemonStartupSecurityAudit("status", {})).toBe(false);
  });

  it("skips the duplicate audit when the detached child re-enters main", async () => {
    process.env.AGENC_DAEMON_RUN = "1";
    process.env[AGENC_DAEMON_STARTUP_GUARD_ENV] = startupGuardToken;
    Object.defineProperty(process, "send", {
      configurable: true,
      value: vi.fn(),
    });

    await expect(main()).resolves.toBe(0);

    expect(securityMocks.buildAudit).not.toHaveBeenCalled();
    expect(daemonMocks.run).toHaveBeenCalledTimes(1);
  });

  it("keeps the audit for a direct foreground launch", async () => {
    process.env.AGENC_DAEMON_RUN = "1";
    process.env[AGENC_DAEMON_STARTUP_GUARD_ENV] = startupGuardToken;
    Reflect.deleteProperty(process, "send");

    await expect(main()).resolves.toBe(0);

    expect(securityMocks.buildAudit).toHaveBeenCalledTimes(1);
    expect(securityMocks.buildAudit).toHaveBeenCalledWith({
      env: process.env,
      inspectNativeCredentials: false,
    });
    expect(daemonMocks.run).toHaveBeenCalledTimes(1);
  });
});
