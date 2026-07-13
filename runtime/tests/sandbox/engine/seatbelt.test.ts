import { describe, expect, it } from "vitest";

import { restrictedFileSystemPolicy, unrestrictedFileSystemPolicy } from "./index.js";
import {
  MACOS_PATH_TO_SEATBELT_EXECUTABLE,
  MACOS_SEATBELT_GPU_POLICY,
  createSeatbeltCommandArgs,
  seatbeltRegexForUnreadableGlob,
} from "./seatbelt.js";

describe("macOS seatbelt policy generation", () => {
  it("builds file, proxy, and unix-socket policy sections", () => {
    const args = createSeatbeltCommandArgs({
      command: ["/bin/echo", "ok"],
      fileSystemSandboxPolicy: restrictedFileSystemPolicy(
        [
          { path: { kind: "path", path: "/repo" }, access: "write" },
          { path: { kind: "path", path: "/usr/bin" }, access: "read" },
          { path: { kind: "glob", pattern: "secrets/**/*.pem" }, access: "none" },
        ],
        { globScanMaxDepth: 4 },
      ),
      networkSandboxPolicy: "disabled",
      sandboxPolicyCwd: "/repo",
      enforceManagedNetwork: true,
      network: {
        env: { HTTPS_PROXY: "localhost:9443" },
        allowLocalBinding: true,
        allowUnixSockets: ["/tmp/agenc.sock"],
      },
    });

    expect(MACOS_PATH_TO_SEATBELT_EXECUTABLE).toBe("/usr/bin/sandbox-exec");
    expect(args[0]).toBe("-p");
    expect(args.slice(args.indexOf("--"))).toEqual(["--", "/bin/echo", "ok"]);
    const policy = args[1] ?? "";
    expect(policy).toContain("(deny default)");
    expect(policy).toContain("(allow file-read*");
    expect(policy).toContain("(allow file-write*");
    expect(policy).toContain("WRITABLE_ROOT_0");
    expect(policy).toContain("READABLE_ROOT_0");
    expect(policy).toContain("localhost:9443");
    expect(policy).toContain("UNIX_SOCKET_PATH_0");
    expect(policy).toContain("(deny file-read* (regex #\"^/repo/secrets/(.*/)?[^/]*\\.pem$\"))");
    expect(args).toContain("-DWRITABLE_ROOT_0=/repo");
    expect(args.some((arg) => /^-DREADABLE_ROOT_\d+=\/usr\/bin$/u.test(arg))).toBe(true);
    expect(args).toContain("-DUNIX_SOCKET_PATH_0=/tmp/agenc.sock");
  });

  it("treats bracketed IPv6 loopback proxy URLs as local proxy ports", () => {
    const args = createSeatbeltCommandArgs({
      command: ["/bin/echo", "ok"],
      fileSystemSandboxPolicy: restrictedFileSystemPolicy(),
      networkSandboxPolicy: "disabled",
      sandboxPolicyCwd: "/repo",
      enforceManagedNetwork: true,
      network: {
        env: { HTTPS_PROXY: "http://[::1]:9443" },
      },
    });

    expect(args[1]).toContain(
      `(allow network-outbound (remote ip "localhost:9443"))`,
    );
  });

  it("honors explicit metadata writes expressed as project-root subpaths", () => {
    const args = createSeatbeltCommandArgs({
      command: ["/bin/echo", "ok"],
      fileSystemSandboxPolicy: restrictedFileSystemPolicy([
        { path: { kind: "special", value: { kind: "project_roots" } }, access: "write" },
        {
          path: {
            kind: "special",
            value: { kind: "project_roots", subpath: ".agenc" },
          },
          access: "write",
        },
      ]),
      networkSandboxPolicy: "disabled",
      sandboxPolicyCwd: "/repo",
      enforceManagedNetwork: false,
    });

    expect(args[1]).not.toContain("^/repo/\\.agenc(/.*)?$");
    expect(args).not.toContain("-DWRITABLE_ROOT_0_EXCLUDED_1=/repo/.agenc");
  });

  it("retains full-network behavior when no managed proxy is configured", () => {
    const args = createSeatbeltCommandArgs({
      command: ["true"],
      fileSystemSandboxPolicy: unrestrictedFileSystemPolicy(),
      networkSandboxPolicy: "enabled",
      sandboxPolicyCwd: "/repo",
      enforceManagedNetwork: false,
    });

    const policy = args[1] ?? "";
    expect(policy).toContain("(allow network-outbound)");
    expect(policy).toContain("(allow network-inbound)");
    expect(policy).toContain("DARWIN_USER_CACHE_DIR");
  });

  it("does not source the macOS user cache directory from process env", () => {
    const previous = process.env["DARWIN_USER_CACHE_DIR"];
    process.env["DARWIN_USER_CACHE_DIR"] = "/repo/.git";
    try {
      const args = createSeatbeltCommandArgs({
        command: ["true"],
        fileSystemSandboxPolicy: unrestrictedFileSystemPolicy(),
        networkSandboxPolicy: "enabled",
        sandboxPolicyCwd: "/repo",
        enforceManagedNetwork: false,
      });

      expect(args).not.toContain("-DDARWIN_USER_CACHE_DIR=/repo/.git");
    } finally {
      if (previous === undefined) {
        delete process.env["DARWIN_USER_CACHE_DIR"];
      } else {
        process.env["DARWIN_USER_CACHE_DIR"] = previous;
      }
    }
  });

  it("translates unreadable glob patterns into anchored seatbelt regexes", () => {
    expect(seatbeltRegexForUnreadableGlob("/repo/secrets/**/*.pem")).toBe(
      "^/repo/secrets/(.*/)?[^/]*\\.pem$",
    );
    expect(seatbeltRegexForUnreadableGlob("/repo/private")).toBe(
      "^/repo/private(/.*)?$",
    );
    expect(seatbeltRegexForUnreadableGlob("")).toBeNull();
  });
});

describe("macOS seatbelt GPU allowance (opt-in)", () => {
  const baseParams = {
    command: ["/bin/echo", "ok"],
    fileSystemSandboxPolicy: restrictedFileSystemPolicy(),
    networkSandboxPolicy: "disabled",
    sandboxPolicyCwd: "/repo",
    enforceManagedNetwork: false,
  } as const;

  it("denies GPU user clients and the Metal compiler by default", () => {
    const args = createSeatbeltCommandArgs({ ...baseParams });
    const policy = args[1] ?? "";
    expect(policy).not.toContain("AGXDeviceUserClient");
    expect(policy).not.toContain("MTLCompilerService");
  });

  it("adds only Metal compute rules when allowGpu is set", () => {
    const args = createSeatbeltCommandArgs({ ...baseParams, allowGpu: true });
    const policy = args[1] ?? "";
    expect(policy).toContain(MACOS_SEATBELT_GPU_POLICY);
    expect(policy).toContain('(iokit-user-client-class "AGXDeviceUserClient")');
    expect(policy).toContain('(global-name "com.apple.MTLCompilerService")');
    // The GPU opt-in must not widen display-adjacent surfaces.
    expect(policy).not.toContain("WindowServer");
    expect(policy).not.toContain("IOSurfaceRootUserClient");
  });
});
