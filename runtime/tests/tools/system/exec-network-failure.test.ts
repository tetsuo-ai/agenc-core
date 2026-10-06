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
      "curl: (6) Could not resolve host: example.org",
      "fatal: unable to access https://example.org: Could not resolve host: example.org",
      "Temporary failure in name resolution", "[Errno -2] Name or service not known", "connect ENETUNREACH", "Network is unreachable"]) {
      expect(notice({ output })).toContain("network access was disabled");
      expect(notice({ output })).toContain("approval is unavailable");
      expect(notice({ output })).not.toContain("request it");
    }
    expect(notice({ escalationAvailable: true })).toContain("approval flow before retrying");
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
  });
});
