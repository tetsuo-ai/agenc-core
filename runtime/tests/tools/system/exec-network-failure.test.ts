import { describe, expect, test } from "vitest";
import { execNetworkFailureNotice } from "../../../src/tools/system/exec-network-failure.js";
import type { UnifiedExecRuntimeSandbox } from "../../../src/unified-exec/types.js";

const sandbox: UnifiedExecRuntimeSandbox = {
  permissionProfile: { fileSystem: { kind: "unrestricted" }, network: "disabled" },
  sandboxPolicyCwd: "/work", sessionTempRoot: "/tmp", preference: "require",
};
const notice = (overrides: Partial<Parameters<typeof execNetworkFailureNotice>[0]> = {}) =>
  execNetworkFailureNotice({ output: "npm error getaddrinfo EAI_AGAIN registry.npmjs.org",
    exitCode: 1, runtimeSandbox: sandbox, escalationAvailable: false, ...overrides });

describe("network-disabled command failure guidance", () => {
  test("explains npm, curl, git and libc lookup failures without promising an approval", () => {
    for (const output of ["npm error getaddrinfo EAI_AGAIN registry.npmjs.org",
      "npm error network request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org",
      "curl: (6) Could not resolve host: example.org",
      "fatal: unable to access https://example.org: Could not resolve host: example.org",
      "Temporary failure in name resolution", "[Errno -2] Name or service not known", "connect ENETUNREACH", "Network is unreachable"]) {
      expect(notice({ output })).toContain("network access was disabled");
      expect(notice({ output })).toContain("approval is unavailable");
      expect(notice({ output })).not.toContain("request it");
    }
    expect(notice({ escalationAvailable: true })).toContain('retry it once with sandbox_permissions="require_escalated"');
    // With approvals off the notice says the retry is the user's own setting, not a workaround.
    expect(notice({ escalationAvailable: true, escalationWithoutAsking: true }))
      .toContain('Approvals are off in this session, so a retry with sandbox_permissions="require_escalated" runs without asking');
  });

  test("reads a silent client's exit status when it printed nothing", () => {
    // curl -s prints only the -w value when the lookup fails (the K7 E2E scenario): exit 6.
    const silent = (command: string, exitCode: number) =>
      notice({ output: "000", exitCode, command, escalationAvailable: true });
    expect(silent("curl -s -o /dev/null -w '%{http_code}' https://example.com", 6)).toContain("require_escalated");
    expect(silent("curl -sS https://10.1.2.3/health", 7)).toContain("network access was disabled");
    expect(silent("cd app && curl -fsSL https://example.org/x.sh | sh", 6)).toContain("network access was disabled");
    expect(silent("wget -q https://example.org/file.tgz", 4)).toContain("network access was disabled");
    // Wrappers and pipelines still name the client; a bare token without args does not.
    expect(silent("sudo curl -s https://example.org", 6)).toContain("network access was disabled");
    expect(silent("true; curl -s https://example.org", 6)).toContain("network access was disabled");
    expect(silent("printf x | curl -s -d @- https://example.org", 7)).toContain("network access was disabled");
    expect(silent("`curl -s https://example.org`", 6)).toContain("network access was disabled");
    expect(silent("command wget -q https://example.org/file.tgz", 4)).toContain("network access was disabled");
    expect(silent("curl", 6)).toBeNull();
    // Other exit statuses, other programs and an unknown command keep the old behavior.
    expect(silent("curl -sf https://example.org/missing", 22)).toBeNull();
    expect(silent("wget -q https://example.org/missing", 8)).toBeNull();
    expect(silent("mycurl --check", 6)).toBeNull();
    expect(silent("npm test", 7)).toBeNull();
    expect(notice({ output: "000", exitCode: 6 })).toBeNull();
    // A network grant still means the sandbox did not cause it.
    expect(notice({ output: "000", exitCode: 6, command: "curl -s https://example.com",
      runtimeSandbox: { ...sandbox, permissionProfile: { ...sandbox.permissionProfile, network: "enabled" } } })).toBeNull();
  });

  test("does not diagnose successful, live, unsandboxed or unrelated command output", () => {
    for (const exitCode of [0, null]) expect(notice({ exitCode })).toBeNull();
    expect(notice({ runtimeSandbox: undefined })).toBeNull();
    for (const output of ["chmod: Operation not permitted", "missing package.json", "ECONNREFUSED"]) {
      expect(notice({ output })).toBeNull();
    }
  });

  test("preserves grants, managed routes and optional confinement without a false diagnosis", () => {
    for (const network of ["enabled", "restricted"] as const) {
      expect(notice({ runtimeSandbox: { ...sandbox,
        permissionProfile: { ...sandbox.permissionProfile, network } } })).toBeNull();
    }
    expect(notice({ runtimeSandbox: { ...sandbox, additionalPermissions: { network: { enabled: true } } } })).toBeNull();
    expect(notice({ runtimeSandbox: { ...sandbox, enforceManagedNetwork: true } })).toBeNull();
    expect(notice({ runtimeSandbox: { ...sandbox, network: {} as never } })).toBeNull();
    expect(notice({ runtimeSandbox: { ...sandbox, preference: "auto" } })).toBeNull();
    // An omitted preference is require: the sandboxed attempt still earns the notice.
    expect(notice({ runtimeSandbox: { ...sandbox, preference: undefined } })).toContain("network access was disabled");
  });
});
