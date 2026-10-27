import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SandboxManager,
  restrictedFileSystemPolicy,
  unrestrictedFileSystemPolicy,
} from "./index.js";
import {
  MACOS_PATH_TO_SEATBELT_EXECUTABLE,
  MACOS_SEATBELT_CHROMIUM_BUNDLE_POLICY,
  MACOS_SEATBELT_CHROMIUM_POLICY,
  MACOS_SEATBELT_CHROMIUM_TEMP_POLICY,
  MACOS_SEATBELT_GPU_POLICY,
  chromiumBundleIdentifier,
  createSeatbeltCommandArgs,
  darwinUserTempDir,
  seatbeltRegexForUnreadableGlob,
} from "./seatbelt.js";

const TEST_SESSION_TEMP_ROOT = "/tmp/agenc-seatbelt-session-root";

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
      sessionTempRoot: TEST_SESSION_TEMP_ROOT,
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
      sessionTempRoot: TEST_SESSION_TEMP_ROOT,
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
      sessionTempRoot: TEST_SESSION_TEMP_ROOT,
      enforceManagedNetwork: false,
    });

    expect(args[1]).not.toContain("^/repo/\\.agenc(/.*)?$");
    expect(args).not.toContain("-DWRITABLE_ROOT_0_EXCLUDED_1=/repo/.agenc");
  });

  it("binds tmpdir specials to explicit session authority", () => {
    const previous = process.env["TMPDIR"];
    process.env["TMPDIR"] = "/tmp/generic-must-not-win";
    try {
      const args = createSeatbeltCommandArgs({
        command: ["true"],
        fileSystemSandboxPolicy: restrictedFileSystemPolicy([
          {
            path: { kind: "special", value: { kind: "tmpdir" } },
            access: "write",
          },
        ]),
        networkSandboxPolicy: "disabled",
        sandboxPolicyCwd: "/repo",
        sessionTempRoot: TEST_SESSION_TEMP_ROOT,
        enforceManagedNetwork: false,
      });

      expect(args).toContain(
        `-DWRITABLE_ROOT_0=${TEST_SESSION_TEMP_ROOT}`,
      );
      expect(args).not.toContain("-DWRITABLE_ROOT_0=/tmp/generic-must-not-win");
    } finally {
      if (previous === undefined) {
        delete process.env["TMPDIR"];
      } else {
        process.env["TMPDIR"] = previous;
      }
    }
  });

  it("retains full-network behavior when no managed proxy is configured", () => {
    const args = createSeatbeltCommandArgs({
      command: ["true"],
      fileSystemSandboxPolicy: unrestrictedFileSystemPolicy(),
      networkSandboxPolicy: "enabled",
      sandboxPolicyCwd: "/repo",
      sessionTempRoot: TEST_SESSION_TEMP_ROOT,
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
        sessionTempRoot: TEST_SESSION_TEMP_ROOT,
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

  describe("macOS user cache directory lookup", () => {
    type SpawnSync = typeof import("node:child_process").spawnSync;
    let cacheDir = "";
    let platform: PropertyDescriptor | undefined;

    beforeEach(() => {
      cacheDir = realpathSync(mkdtempSync(join(tmpdir(), "agenc-darwin-cache-")));
      platform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    });

    afterEach(() => {
      if (platform !== undefined) Object.defineProperty(process, "platform", platform);
      vi.doUnmock("node:child_process");
      vi.resetModules();
      rmSync(cacheDir, { recursive: true, force: true });
    });

    async function seatbeltWithGetconf(
      answer: (call: number) => { readonly status: number; readonly stdout: string },
    ): Promise<{
      readonly calls: string[][];
      readonly argsFor: () => string[];
    }> {
      const calls: string[][] = [];
      // The shared setup already loaded the sandbox engine; count getconf in
      // a fresh module graph.
      vi.resetModules();
      vi.doMock("node:child_process", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:child_process")>();
        const spawnSync = ((command: string, args?: readonly string[], options?: unknown) => {
          if (command === "/usr/bin/getconf") {
            calls.push([...(args ?? [])]);
            const { status, stdout } = answer(calls.length);
            return { pid: 0, output: [null, stdout, ""], stdout, stderr: "", status, signal: null };
          }
          return (actual.spawnSync as (...rest: unknown[]) => unknown)(command, args, options);
        }) as unknown as SpawnSync;
        return { ...actual, default: { ...actual, spawnSync }, spawnSync };
      });
      const seatbelt = await import("../../../src/sandbox/engine/seatbelt.js");
      return {
        calls,
        argsFor: () =>
          seatbelt.createSeatbeltCommandArgs({
            command: ["true"],
            fileSystemSandboxPolicy: unrestrictedFileSystemPolicy(),
            networkSandboxPolicy: "enabled",
            sandboxPolicyCwd: "/repo",
            sessionTempRoot: TEST_SESSION_TEMP_ROOT,
            enforceManagedNetwork: false,
          }),
      };
    }

    it("asks getconf once per process and keeps the same policy", async () => {
      const seatbelt = await seatbeltWithGetconf(() => ({ status: 0, stdout: `${cacheDir}\n` }));

      const first = seatbelt.argsFor();
      const second = seatbelt.argsFor();

      expect(seatbelt.calls).toEqual([["DARWIN_USER_CACHE_DIR"]]);
      expect(first).toContain(`-DDARWIN_USER_CACHE_DIR=${cacheDir}`);
      expect(second).toEqual(first);
    });

    it("asks again after a failed lookup", async () => {
      const seatbelt = await seatbeltWithGetconf((call) =>
        call === 1 ? { status: 1, stdout: "" } : { status: 0, stdout: `${cacheDir}\n` },
      );

      expect(seatbelt.argsFor().some((arg) => arg.startsWith("-DDARWIN_USER_CACHE_DIR="))).toBe(false);
      expect(seatbelt.argsFor()).toContain(`-DDARWIN_USER_CACHE_DIR=${cacheDir}`);
      expect(seatbelt.argsFor()).toContain(`-DDARWIN_USER_CACHE_DIR=${cacheDir}`);
      expect(seatbelt.calls).toHaveLength(2);
    });
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
    sessionTempRoot: TEST_SESSION_TEMP_ROOT,
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

describe("macOS seatbelt Chromium launch (Browser tool only)", () => {
  const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const baseParams = {
    command: ["/bin/echo", "ok"],
    fileSystemSandboxPolicy: restrictedFileSystemPolicy(),
    networkSandboxPolicy: "disabled",
    sandboxPolicyCwd: "/repo",
    sessionTempRoot: TEST_SESSION_TEMP_ROOT,
    enforceManagedNetwork: false,
  } as const;
  const chromeArgs = (bundleIdentifier: string | undefined): string[] =>
    createSeatbeltCommandArgs({
      ...baseParams,
      command: [CHROME, "--headless=new", "about:blank"],
      chromiumBrowser: { bundleIdentifier },
    });

  it("keeps LaunchServices and Chromium's Mach names out of every other profile", () => {
    const args = createSeatbeltCommandArgs({ ...baseParams });
    const policy = args[1] ?? "";
    expect(policy).not.toContain("com.apple.coreservices.launchservicesd");
    expect(policy).not.toContain("org.chromium.");
    expect(policy).not.toContain("(local-name-prefix \"\")");
    expect(args.some((arg) => arg.startsWith("-DCHROMIUM_MACH_NAME_PREFIX="))).toBe(false);
  });

  it("lets Chromium register with LaunchServices and name its own processes", () => {
    const args = chromeArgs("com.google.Chrome");
    const policy = args[1] ?? "";
    expect(policy).toContain(MACOS_SEATBELT_CHROMIUM_POLICY);
    expect(policy).toContain('(global-name "com.apple.coreservices.launchservicesd")');
    expect(policy).toContain('(global-name-prefix "org.chromium.")');
    expect(policy).toContain(MACOS_SEATBELT_CHROMIUM_BUNDLE_POLICY);
    expect(args).toContain("-DCHROMIUM_MACH_NAME_PREFIX=com.google.Chrome.");
    expect(args.slice(args.indexOf("--"))).toEqual([
      "--", CHROME, "--headless=new", "about:blank",
    ]);
  });

  it("keeps the user's data services and the GPU blocked for the browser", () => {
    const policy = chromeArgs("com.google.Chrome")[1] ?? "";
    for (const name of [
      "com.apple.pasteboard",
      "com.apple.coreservices.appleevents",
      "com.apple.securityd",
      "CoreAuthentication",
      "CoreLocation",
      "locationd",
      "com.apple.metadata.mds",
      "com.apple.bird",
      "usernoted",
      "AGXDeviceUserClient",
      "IOSurfaceRootUserClient",
      "MTLCompilerService",
    ]) {
      expect(policy).not.toContain(name);
    }
    expect(policy).not.toMatch(/\(allow mach-lookup\)/u);
    expect(policy).not.toMatch(/\(allow mach-register\)/u);
  });

  it("names only org.chromium. processes when the bundle is unknown or malformed", () => {
    for (const bundleIdentifier of [undefined, "", 'x")) (allow default) (("']) {
      const args = chromeArgs(bundleIdentifier);
      expect(args[1]).toContain(MACOS_SEATBELT_CHROMIUM_POLICY);
      expect(args[1]).not.toContain(MACOS_SEATBELT_CHROMIUM_BUNDLE_POLICY);
      expect(args.some((arg) => arg.startsWith("-DCHROMIUM_MACH_NAME_PREFIX="))).toBe(false);
    }
  });

  it("lets the browser create its process-singleton folder in the per-user temp folder", () => {
    const args = createSeatbeltCommandArgs({
      ...baseParams,
      command: [CHROME],
      chromiumBrowser: { bundleIdentifier: "com.google.Chrome", userTempDir: "/private/var/folders/ab/xyz/T" },
    });
    expect(args[1]).toContain(MACOS_SEATBELT_CHROMIUM_TEMP_POLICY);
    expect(args).toContain("-DCHROMIUM_USER_TEMP_DIR=/private/var/folders/ab/xyz/T");
    for (const without of [chromeArgs("com.google.Chrome"), createSeatbeltCommandArgs({ ...baseParams })]) {
      expect(without[1]).not.toContain(MACOS_SEATBELT_CHROMIUM_TEMP_POLICY);
      expect(without.some((arg) => arg.startsWith("-DCHROMIUM_USER_TEMP_DIR="))).toBe(false);
    }
  });

  it("looks for the per-user temp folder only on macOS", () => {
    expect(darwinUserTempDir("linux")).toBeUndefined();
  });
});

describe("chromiumBundleIdentifier", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "agenc-chromium-bundle-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const xmlPlist = (identifier: string): string =>
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n' +
    "\t<key>CFBundleExecutable</key>\n\t<string>Browser</string>\n" +
    `\t<key>CFBundleIdentifier</key>\n\t<string>${identifier}</string>\n` +
    "</dict>\n</plist>\n";
  function makeApp(name: string, plist?: string): string {
    const macos = join(dir, `${name}.app`, "Contents", "MacOS");
    mkdirSync(macos, { recursive: true });
    if (plist !== undefined) {
      writeFileSync(join(dir, `${name}.app`, "Contents", "Info.plist"), plist);
    }
    const executable = join(macos, name);
    writeFileSync(executable, "");
    return executable;
  }

  it("reads the identifier of the app around the executable", () => {
    const executable = makeApp("Google Chrome", xmlPlist("com.google.Chrome"));
    expect(chromiumBundleIdentifier(executable)).toBe("com.google.Chrome");
  });

  it("follows a symlink to the executable", () => {
    const executable = makeApp("Chromium", xmlPlist("org.chromium.Chromium"));
    const link = join(dir, "chromium");
    symlinkSync(executable, link);
    expect(chromiumBundleIdentifier(link)).toBe("org.chromium.Chromium");
  });

  it("has no identifier for a bare binary, a missing plist or a malformed value", () => {
    const bare = join(dir, "chrome-headless-shell");
    writeFileSync(bare, "");
    expect(chromiumBundleIdentifier(bare)).toBeUndefined();
    expect(chromiumBundleIdentifier(join(dir, "missing"))).toBeUndefined();
    expect(chromiumBundleIdentifier(makeApp("NoPlist"))).toBeUndefined();
    expect(chromiumBundleIdentifier(makeApp("Odd", xmlPlist("a b")))).toBeUndefined();
  });

  it("feeds the identifier into the profile the engine builds", () => {
    const executable = makeApp("Google Chrome", xmlPlist("com.google.Chrome"));
    const transform = (chromiumBrowser: boolean): readonly string[] =>
      new SandboxManager().transform({
        command: { program: executable, args: ["--headless=new"], cwd: "/repo", env: {} },
        permissions: {
          fileSystem: restrictedFileSystemPolicy([
            { path: { kind: "path", path: "/repo" }, access: "write" },
          ]),
          network: "restricted",
        },
        sandbox: "macos_seatbelt",
        platform: "darwin",
        enforceManagedNetwork: false,
        sandboxPolicyCwd: "/repo",
        sessionTempRoot: TEST_SESSION_TEMP_ROOT,
        windowsSandboxLevel: "disabled",
        windowsSandboxPrivateDesktop: false,
        ...(chromiumBrowser ? { chromiumBrowser: true } : {}),
      }).command;

    const browser = transform(true);
    expect(browser[0]).toBe(MACOS_PATH_TO_SEATBELT_EXECUTABLE);
    expect(browser.join("\n")).toContain("com.apple.coreservices.launchservicesd");
    expect(browser).toContain("-DCHROMIUM_MACH_NAME_PREFIX=com.google.Chrome.");
    if (process.platform === "darwin") {
      expect(browser).toContain(`-DCHROMIUM_USER_TEMP_DIR=${darwinUserTempDir()}`);
    }
    const other = transform(false);
    expect(other.join("\n")).not.toContain("com.apple.coreservices.launchservicesd");
    expect(other.some((arg) => arg.startsWith("-DCHROMIUM_MACH_NAME_PREFIX="))).toBe(false);
  });
});
