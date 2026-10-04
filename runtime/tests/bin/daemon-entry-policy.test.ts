import { describe, expect, it } from "vitest";
import { isDirectInvocation, shouldRunDaemonStartupSecurityAudit, shouldUseDetachedDaemonEntry } from "../../src/bin/daemon-entry-policy.js";
import { AGENC_DAEMON_STARTUP_GUARD_ENV } from "../../src/app-server/daemon-startup-guard.js";

const argv = ["node", "/install/bin/agenc", "daemon", "start", "--foreground"];
const env = { AGENC_DAEMON_RUN: "1", [AGENC_DAEMON_STARTUP_GUARD_ENV]: "a".repeat(32) };

describe("guarded daemon entry eligibility", () => {
  it.each(["/install/bin/agenc", "/install/bin/agenc.js", "/install/bin/agenc.mjs", "C:\\install\\bin\\agenc.js"])("accepts only the existing child command at %s", (entry) => {
    const input = { ...env };
    expect(shouldUseDetachedDaemonEntry(["node", entry, ...argv.slice(2)], input, true)).toBe(true);
    expect(shouldRunDaemonStartupSecurityAudit("run", input, true)).toBe(false);
    expect(input).toEqual(env); // eligibility must not consume the capability
  });

  it.each([
    argv.slice(0, 4), [...argv, "--help"], [...argv, "extra"],
    ["node", "/install/bin/agenc", "daemon", "run", "--foreground"],
    ["node", "/install/bin/agenc", "daemon", "restart", "--foreground"],
    ["node", "/install/bin/agenc", "daemon", "--foreground", "start"],
    ["node", "/install/not-agenc.js", ...argv.slice(2)],
    ["node", "/install/bin/agenc-main.js", ...argv.slice(2)],
  ])("leaves non-exact argv %j to ordinary CLI routing", (input) => {
    expect(shouldUseDetachedDaemonEntry(input, env, true)).toBe(false);
  });

  it.each([undefined, "", "invalid token", "a".repeat(1025)])("requires a valid existing guard token: %s", (token) => {
    const input = { ...env, [AGENC_DAEMON_STARTUP_GUARD_ENV]: token };
    expect(shouldUseDetachedDaemonEntry(argv, input, true)).toBe(false);
    expect(shouldRunDaemonStartupSecurityAudit("run", input, true)).toBe(true);
  });

  it("requires IPC, detached-child flag and the normal direct-entry opt-in", () => {
    expect(shouldUseDetachedDaemonEntry(argv, env, false)).toBe(false);
    expect(shouldUseDetachedDaemonEntry(argv, { ...env, AGENC_DAEMON_RUN: "0" }, true)).toBe(false);
    expect(shouldUseDetachedDaemonEntry(argv, { ...env, AGENC_CLI_ENTRY_DISABLE: "1" }, true)).toBe(false);
    expect(isDirectInvocation(argv, { AGENC_CLI_ENTRY_DISABLE: "1" })).toBe(false);
    expect(shouldRunDaemonStartupSecurityAudit("start", env, true)).toBe(true);
    expect(shouldRunDaemonStartupSecurityAudit("restart", env, true)).toBe(true);
  });
});
