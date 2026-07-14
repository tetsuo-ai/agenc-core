import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createBwrapCommandArgs,
  insertInnerCommandArgv0,
} from "./bwrap.js";
import {
  parseLinuxSandboxLauncherArgs,
  LinuxSandboxCliError,
} from "./cli.js";
import { SECCOMP_STDIN_FD } from "./config.js";
import {
  createNetworkSeccompProgram,
  networkSeccompMode,
} from "./landlock.js";
import {
  findSystemBubblewrapInPath,
  preferredBubblewrapLauncher,
} from "./launcher.js";
import {
  activateProxyRoutesInNetns,
  planProxyRoutes,
  prepareHostProxyRoutes,
  prepareHostProxyRouteSpec,
  rewriteProxyEnvValue,
} from "./proxy-routing.js";
import {
  isProcMountFailure,
  runCommandWithSupervision,
  runLinuxSandboxMain,
} from "./linux-run-main.js";
import {
  restrictedFileSystemPolicy,
  unrestrictedFileSystemPolicy,
  type PermissionProfile,
} from "../engine/index.js";

describe("Linux sandbox launcher", () => {
  it("parses the manager handoff arguments and preserves command argv", () => {
    const profile = workspaceWriteProfile("/workspace", "restricted");
    const parsed = parseLinuxSandboxLauncherArgs([
      "--sandbox-policy-cwd",
      "/repo",
      "--command-cwd",
      "/workspace",
      "--permission-profile",
      JSON.stringify(profile),
      "--allow-network-for-proxy",
      "--",
      "/bin/echo",
      "hello world",
    ]);

    expect(parsed.sandboxPolicyCwd).toBe("/repo");
    expect(parsed.commandCwd).toBe("/workspace");
    expect(parsed.allowNetworkForProxy).toBe(true);
    expect(parsed.command).toEqual(["/bin/echo", "hello world"]);
    expect(parsed.permissionProfile).toMatchObject(profile);
  });

  it("rejects malformed handoff input", () => {
    expect(() => parseLinuxSandboxLauncherArgs([])).toThrow(LinuxSandboxCliError);
    expect(() =>
      parseLinuxSandboxLauncherArgs([
        "--permission-profile",
        "{",
        "--",
        "/bin/true",
      ]),
    ).toThrow(/invalid permission profile JSON/u);
    expect(() =>
      parseLinuxSandboxLauncherArgs([
        "--permission-profile",
        JSON.stringify(workspaceWriteProfile("/workspace", "disabled")),
        "--use-legacy-landlock",
        "--apply-seccomp-then-exec",
        "--",
        "/bin/true",
      ]),
    ).toThrow(/cannot be combined/u);
    expect(() =>
      parseLinuxSandboxLauncherArgs([
        "--permission-profile",
        JSON.stringify({ fileSystem: { kind: "restricted", entries: "bad" }, network: "bad" }),
        "--",
        "/bin/true",
      ]),
    ).toThrow(/network must be enabled, disabled, or restricted/u);
    expect(() =>
      parseLinuxSandboxLauncherArgs([
        "--permission-profile",
        JSON.stringify({
          fileSystem: restrictedFileSystemPolicy([
            {
              path: {
                kind: "special",
                value: { kind: "project_roots", subpath: "../outside" },
              },
              access: "read",
            },
          ]),
          network: "disabled",
        }),
        "--",
        "/bin/true",
      ]),
    ).toThrow(/project root subpath must stay within the project root/u);
  });

  it("builds full-filesystem bubblewrap flags for network-isolated full-write policies", () => {
    const args = createBwrapCommandArgs(
      ["/bin/true"],
      unrestrictedFileSystemPolicy(),
      "/",
      "/",
      {
        mountProc: true,
        networkMode: "isolated",
        seccompFd: SECCOMP_STDIN_FD,
      },
    );

    expect(args.usesBubblewrap).toBe(true);
    expect(args.args).toEqual([
      "--new-session",
      "--die-with-parent",
      "--bind",
      "/",
      "/",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--seccomp",
      String(SECCOMP_STDIN_FD),
      "--proc",
      "/proc",
      "--",
      "/bin/true",
    ]);
  });

  it("skips bubblewrap only for full disk write with full network", () => {
    const args = createBwrapCommandArgs(
      ["/bin/true"],
      unrestrictedFileSystemPolicy(),
      "/",
      "/",
      { mountProc: true, networkMode: "full-access" },
    );

    expect(args.usesBubblewrap).toBe(false);
    expect(args.args).toEqual(["/bin/true"]);
  });

  it("maps restricted filesystem policy to writable, readonly, and masked bwrap mounts", () => {
    const root = withTempDir("agenc-linux-launcher-fs-");
    const secret = path.join(root, "token.secret");
    const otherSecret = path.join(root, "other.token");
    fs.writeFileSync(secret, "sensitive");
    fs.writeFileSync(otherSecret, "sensitive");
    const policy = restrictedFileSystemPolicy([
      { path: { kind: "path", path: root }, access: "write" },
      { path: { kind: "glob", pattern: path.join(root, "*.secret") }, access: "none" },
      { path: { kind: "glob", pattern: path.join(root, "*.token") }, access: "none" },
    ]);

    const args = createBwrapCommandArgs(
      ["/bin/true"],
      policy,
      root,
      root,
      { mountProc: true, networkMode: "isolated", seccompFd: SECCOMP_STDIN_FD },
    ).args;

    expect(args).toContain("--tmpfs");
    expect(args).toContain("--dev");
    expect(args).toContain("--bind");
    expect(sliceAfter(args, "--bind")).toEqual([root, root]);
    expect(args).toContain("--ro-bind");
    expect(args).toContain(secret);
    expect(args).toContain(otherSecret);
    expect(args).toContain(path.join(root, ".git"));
    expect(args).toContain("--unshare-net");
  });

  it("fails closed for missing read-only carveouts that cannot be typed", () => {
    const root = withTempDir("agenc-linux-launcher-missing-ro-");
    const policy = restrictedFileSystemPolicy([
      { path: { kind: "path", path: root }, access: "write" },
      { path: { kind: "path", path: path.join(root, "missing-file") }, access: "read" },
    ]);

    expect(() =>
      createBwrapCommandArgs(["/bin/true"], policy, root, root, {
        mountProc: true,
        networkMode: "isolated",
      }),
    ).toThrow(/cannot enforce missing read-only subpath/u);
  });

  it("preserves parent repository discovery while monitoring missing child metadata", () => {
    const parent = withTempDir("agenc-linux-launcher-parent-git-");
    fs.mkdirSync(path.join(parent, ".git"));
    const child = path.join(parent, "child");
    fs.mkdirSync(child);
    const policy = restrictedFileSystemPolicy([
      { path: { kind: "path", path: child }, access: "write" },
    ]);

    const args = createBwrapCommandArgs(["/bin/true"], policy, child, child, {
      mountProc: true,
      networkMode: "isolated",
    });

    expect(args.protectedCreateTargets).toContain(path.join(child, ".git"));
    expect(args.args).not.toContain(path.join(child, ".git"));
  });

  it("masks unreadable ancestors before reopening writable descendants", () => {
    const parent = withTempDir("agenc-linux-launcher-mask-parent-");
    const child = path.join(parent, "child");
    fs.mkdirSync(child);
    const policy = restrictedFileSystemPolicy([
      { path: { kind: "path", path: parent }, access: "none" },
      { path: { kind: "path", path: child }, access: "write" },
    ]);

    const args = createBwrapCommandArgs(["/bin/true"], policy, child, child, {
      mountProc: true,
      networkMode: "isolated",
    }).args;

    const parentMask = args.findIndex((value, index) =>
      value === "--tmpfs" && args[index + 1] === parent,
    );
    const childBind = args.findIndex((value, index) =>
      value === "--bind" && args[index + 1] === child && args[index + 2] === child,
    );
    expect(parentMask).toBeGreaterThanOrEqual(0);
    expect(childBind).toBeGreaterThan(parentMask);
  });

  it("fails an otherwise successful launch when protected metadata is created", async () => {
    const parent = withTempDir("agenc-linux-launcher-protected-parent-");
    fs.mkdirSync(path.join(parent, ".git"));
    const child = path.join(parent, "child");
    const bin = path.join(parent, "bin");
    fs.mkdirSync(child);
    fs.mkdirSync(bin);
    const fakeBwrap = path.join(bin, "bwrap");
    const protectedTarget = path.join(child, ".git");
    writeExecutable(
      fakeBwrap,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.mkdirSync(process.env.AGENC_PROTECTED_TARGET, { recursive: true });",
        "process.exit(0);",
      ].join("\n") + "\n",
    );

    const exitCode = await runLinuxSandboxMain([
      "--sandbox-policy-cwd",
      child,
      "--command-cwd",
      child,
      "--permission-profile",
      JSON.stringify(workspaceWriteProfile(child, "disabled")),
      "--",
      "/bin/true",
    ], {
      env: {
        ...process.env,
        AGENC_PROTECTED_TARGET: protectedTarget,
      },
      selfCommand: [process.execPath, path.join(child, "inner.js")],
      preferredLauncher: () => ({ program: fakeBwrap, supportsArgv0: false }),
    });

    expect(exitCode).toBe(1);
    expect(fs.existsSync(protectedTarget)).toBe(false);
  });

  it("expands unreadable absolute globs from their static root", () => {
    const workspace = withTempDir("agenc-linux-launcher-glob-work-");
    const external = withTempDir("agenc-linux-launcher-glob-external-");
    const secret = path.join(external, "blocked.secret");
    const questionSecret = path.join(external, "blocked-a.secret");
    const classSecret = path.join(external, "blocked-b.secret");
    fs.writeFileSync(secret, "sensitive");
    fs.writeFileSync(questionSecret, "sensitive");
    fs.writeFileSync(classSecret, "sensitive");
    const policy = restrictedFileSystemPolicy([
      { path: { kind: "path", path: workspace }, access: "write" },
      { path: { kind: "path", path: external }, access: "read" },
      { path: { kind: "glob", pattern: path.join(external, "*.secret") }, access: "none" },
      { path: { kind: "glob", pattern: path.join(external, "blocked-?.secret") }, access: "none" },
      { path: { kind: "glob", pattern: path.join(external, "blocked-[bc].secret") }, access: "none" },
      { path: { kind: "glob", pattern: path.join(external, "blocked-[z-a].secret") }, access: "none" },
    ]);

    const args = createBwrapCommandArgs(["/bin/true"], policy, workspace, workspace, {
      mountProc: true,
      networkMode: "isolated",
    });

    expect(args.args).toContain(secret);
    expect(args.args).toContain(questionSecret);
    expect(args.args).toContain(classSecret);
  });

  it("fails closed for root-level unreadable glob scans", () => {
    const workspace = withTempDir("agenc-linux-launcher-root-glob-");
    const policy = restrictedFileSystemPolicy([
      { path: { kind: "path", path: workspace }, access: "write" },
      { path: { kind: "glob", pattern: "/*.secret" }, access: "none" },
    ]);

    expect(() =>
      createBwrapCommandArgs(["/bin/true"], policy, workspace, workspace, {
        mountProc: true,
        networkMode: "isolated",
      }),
    ).toThrow(/too broad/u);
  });

  it("inserts argv0 support before the inner command separator", () => {
    expect(
      insertInnerCommandArgv0(["--proc", "/proc", "--", "/bin/true"], true, "/fallback"),
    ).toEqual([
      "--proc",
      "/proc",
      "--argv0",
      "agenc-linux-sandbox",
      "--",
      "/bin/true",
    ]);
    expect(
      insertInnerCommandArgv0(["--", "/inner", "arg"], false, "/fallback"),
    ).toEqual(["--", "/fallback", "arg"]);
  });

  it("creates a cBPF seccomp program for restricted network mode", () => {
    const program = createNetworkSeccompProgram("restricted", "x64");
    expect(program.length).toBeGreaterThan(8 * 10);
    expect(program.length % 8).toBe(0);
    expect(networkSeccompMode("disabled", false, false)).toBe("restricted");
    expect(networkSeccompMode("enabled", false, false)).toBeNull();
    expect(networkSeccompMode("enabled", true, true)).toBe("proxy-routed");
    const proxyDenied = deniedSyscalls(createNetworkSeccompProgram("proxy-routed", "x64"));
    expect(proxyDenied).toContain(53);
    expect(proxyDenied).not.toContain(42);
    expect(proxyDenied).not.toContain(49);
    expect(proxyDenied).not.toContain(50);
    expect(() =>
      createNetworkSeccompProgram("restricted", "ppc64" as NodeJS.Architecture),
    ).toThrow(/does not support/u);
  });

  it("discovers system bubblewrap while ignoring workspace-local candidates", () => {
    const root = withTempDir("agenc-linux-launcher-path-");
    const cwd = path.join(root, "workspace");
    const trusted = path.join(root, "trusted-bin");
    const attacker = path.join(root, "attacker-bin");
    fs.mkdirSync(cwd);
    fs.mkdirSync(trusted);
    fs.mkdirSync(attacker);
    writeExecutable(path.join(cwd, "bwrap"), "#!/bin/sh\nexit 0\n");
    writeExecutable(path.join(attacker, "bwrap"), "#!/bin/sh\nexit 0\n");
    const trustedBwrap = path.join(trusted, "bwrap");
    writeExecutable(trustedBwrap, "#!/bin/sh\necho --argv0\n");

    expect(findSystemBubblewrapInPath([cwd, attacker].join(path.delimiter), cwd)).toBeNull();
    expect(
      findSystemBubblewrapInPath(
        [cwd, attacker, trusted].join(path.delimiter),
        cwd,
        [trusted],
      ),
    ).toBe(fs.realpathSync(trustedBwrap));
    expect(
      preferredBubblewrapLauncher({
        searchPath: trusted,
        cwd,
        trustedDirectories: [trusted],
      }),
    ).toEqual({ program: fs.realpathSync(trustedBwrap), supportsArgv0: true });
  });

  it("runs bubblewrap through a real subprocess and passes the seccomp FD", async () => {
    const root = withTempDir("agenc-linux-launcher-run-");
    const bin = path.join(root, "bin");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(bin);
    fs.mkdirSync(workspace);
    const capture = path.join(root, "capture.json");
    const innerCapture = path.join(root, "inner-capture.json");
    const fakeBwrap = path.join(bin, "bwrap");
    writeExecutable(
      fakeBwrap,
      [
        "#!/usr/bin/env node",
        "const cp = require('node:child_process');",
        "const fs = require('node:fs');",
        "const argv = process.argv.slice(2);",
        "let fd3Open = false;",
        "try { fs.fstatSync(3); fd3Open = true; } catch {}",
        "fs.writeFileSync(process.env.AGENC_FAKE_BWRAP_CAPTURE, JSON.stringify({ argv, fd3Open }, null, 2));",
        "const separator = argv.indexOf('--');",
        "const command = separator === -1 ? [] : argv.slice(separator + 1);",
        "if (command.length === 0) process.exit(97);",
        "const child = cp.spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: process.env, cwd: process.cwd() });",
        "process.exit(child.status ?? 1);",
      ].join("\n") + "\n",
    );
    const inner = path.join(workspace, "inner.js");
    fs.writeFileSync(
      inner,
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.AGENC_INNER_CAPTURE, JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  active: process.env.AGENC_LINUX_SANDBOX_ACTIVE,",
        "}, null, 2));",
        "process.exit(0);",
      ].join("\n") + "\n",
    );
    const profile = workspaceWriteProfile(workspace, "disabled");

    const exitCode = await runLinuxSandboxMain([
      "--sandbox-policy-cwd",
      workspace,
      "--command-cwd",
      workspace,
      "--permission-profile",
      JSON.stringify(profile),
      "--",
      "/bin/true",
    ], {
      env: {
        ...process.env,
        PATH: [bin, process.env.PATH ?? ""].join(path.delimiter),
        AGENC_FAKE_BWRAP_CAPTURE: capture,
        AGENC_INNER_CAPTURE: innerCapture,
      },
      selfCommand: [process.execPath, inner],
      preferredLauncher: () => ({ program: fakeBwrap, supportsArgv0: true }),
    });

    expect(exitCode).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(capture, "utf8")) as {
      argv: string[];
      fd3Open: boolean;
    };
    expect(recorded.fd3Open).toBe(true);
    expect(recorded.argv).toContain("--unshare-user");
    expect(recorded.argv).toContain("--unshare-pid");
    expect(recorded.argv).toContain("--unshare-net");
    expect(recorded.argv).toContain("--seccomp");
    expect(recorded.argv).toContain(String(SECCOMP_STDIN_FD));
    expect(recorded.argv).toContain("--argv0");
    expect(recorded.argv).toContain("agenc-linux-sandbox");
    expect(recorded.argv).toContain("--apply-seccomp-then-exec");
    expect(recorded.argv).toContain("/bin/true");
    const innerRecorded = JSON.parse(fs.readFileSync(innerCapture, "utf8")) as {
      argv: string[];
      active: string | undefined;
    };
    expect(innerRecorded.active).toBe("1");
    expect(innerRecorded.argv).toContain("--apply-seccomp-then-exec");
    expect(innerRecorded.argv.slice(innerRecorded.argv.indexOf("--") + 1)).toEqual([
      "/bin/true",
    ]);
  });

  it("blocks network syscalls with real bubblewrap when the platform allows it", async () => {
    const bwrap = findSystemBubblewrapInPath(process.env.PATH, process.cwd());
    if (bwrap === null || !systemBubblewrapWorks(bwrap)) return;
    const root = withTempDir("agenc-linux-launcher-real-bwrap-");
    const profile: PermissionProfile = {
      fileSystem: unrestrictedFileSystemPolicy(),
      network: "disabled",
    };
    const script = [
      "const net = require('node:net');",
      "const socket = net.connect({ host: '198.51.100.10', port: 9 });",
      "socket.once('connect', () => process.exit(3));",
      "socket.once('error', () => process.exit(0));",
      "setTimeout(() => process.exit(0), 500);",
    ].join("");
    // This is the one sanctioned native-network probe: bubblewrap creates the
    // isolated network namespace before this Node command starts. Remove the
    // JavaScript preload so the assertion exercises the kernel boundary, not
    // the default-suite tripwire. No public route exists inside the namespace.
    const probeEnv = { ...process.env };
    delete probeEnv.NODE_OPTIONS;
    delete probeEnv.AGENC_TEST_NETWORK_ATTEMPT_LEDGER;

    const exitCode = await runLinuxSandboxMain([
      "--sandbox-policy-cwd",
      root,
      "--command-cwd",
      root,
      "--permission-profile",
      JSON.stringify(profile),
      "--no-proc",
      "--",
      process.execPath,
      "-e",
      script,
    ], {
      env: probeEnv,
      preferredLauncher: () => ({ program: bwrap, supportsArgv0: true }),
    });

    expect(exitCode).toBe(0);
  });

  it("ships the launcher as an executable package binary", () => {
    const runtimeRoot = process.cwd();
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8"),
    ) as { bin?: Record<string, string> };
    const binPath = path.join(runtimeRoot, "bin", "agenc-linux-sandbox");

    expect(packageJson.bin?.["agenc-linux-sandbox"]).toBe("bin/agenc-linux-sandbox");
    expect(fs.statSync(binPath).mode & 0o111).not.toBe(0);
  });

  it("supervises a direct child process exit", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(String(code))));
    });

    await expect(
      runCommandWithSupervision(
        [process.execPath, "-e", "process.exit(7)"],
        { cwd: process.cwd(), env: process.env, argv0: "agenc-linux-sandbox" },
      ),
    ).resolves.toBe(7);
  });

  it("validates managed proxy route inputs without accepting non-loopback endpoints", () => {
    const plan = planProxyRoutes({
      HTTP_PROXY: "http://127.0.0.1:3128",
      NPM_CONFIG_PROXY: "socks4://127.0.0.1",
      npm_config_http_proxy: "http://localhost:4873",
      PIP_PROXY: "127.0.0.1:1081",
      HTTPS_PROXY: "http://203.0.113.12:4444",
      PATH: "/usr/bin",
    });

    expect(plan.hasProxyConfig).toBe(true);
    expect(plan.routes).toEqual([
      { envKey: "HTTP_PROXY", host: "127.0.0.1", port: 3128 },
      { envKey: "NPM_CONFIG_PROXY", host: "127.0.0.1", port: 1080 },
      { envKey: "npm_config_http_proxy", host: "localhost", port: 4873 },
      { envKey: "PIP_PROXY", host: "127.0.0.1", port: 1081 },
    ]);
    expect(rewriteProxyEnvValue("http://127.0.0.1:8080", 43210)).toBe(
      "http://127.0.0.1:43210",
    );
    expect(rewriteProxyEnvValue("socks5h://127.0.0.1:8081", 43210)).toBe(
      "socks5h://127.0.0.1:43210",
    );
    expect(rewriteProxyEnvValue("socks4a://127.0.0.1", 43210)).toBe(
      "socks4a://127.0.0.1:43210",
    );
    expect(() => prepareHostProxyRouteSpec({ PATH: "/usr/bin" })).toThrow(
      /requires proxy environment variables/u,
    );
  });

  it("rejects the inner apply stage unless bubblewrap launched it", async () => {
    const root = withTempDir("agenc-linux-launcher-inner-");
    const profile = workspaceWriteProfile(root, "disabled");
    const stderr: string[] = [];

    const exitCode = await runLinuxSandboxMain([
      "--sandbox-policy-cwd",
      root,
      "--command-cwd",
      root,
      "--permission-profile",
      JSON.stringify(profile),
      "--apply-seccomp-then-exec",
      "--",
      "/bin/true",
    ], {
      onStderr(line) {
        stderr.push(line);
      },
    });

    expect(exitCode).toBe(2);
    expect(stderr.join("\n")).toMatch(/must run inside bubblewrap/u);
  });

  it("applies proxy-routed seccomp through inner bubblewrap after route activation", async () => {
    const root = withTempDir("agenc-linux-launcher-inner-proxy-");
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const capture = path.join(root, "inner-seccomp.json");
    const fakeBwrap = path.join(bin, "bwrap");
    writeExecutable(
      fakeBwrap,
      [
        "#!/usr/bin/env node",
        "const cp = require('node:child_process');",
        "const fs = require('node:fs');",
        "const argv = process.argv.slice(2);",
        "let fd3Open = false;",
        "try { fs.fstatSync(3); fd3Open = true; } catch {}",
        "fs.writeFileSync(process.env.AGENC_INNER_SECCOMP_CAPTURE, JSON.stringify({ argv, fd3Open }, null, 2));",
        "const separator = argv.indexOf('--');",
        "const command = separator === -1 ? [] : argv.slice(separator + 1);",
        "if (command.length === 0) process.exit(97);",
        "const child = cp.spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: process.env, cwd: process.cwd() });",
        "process.exit(child.status ?? 1);",
      ].join("\n") + "\n",
    );
    const env = {
      ...process.env,
      HTTP_PROXY: "http://127.0.0.1:3128",
      AGENC_LINUX_SANDBOX_ACTIVE: "1",
      AGENC_INNER_SECCOMP_CAPTURE: capture,
    };
    const prepared = await prepareHostProxyRoutes(env);
    try {
      const exitCode = await runLinuxSandboxMain([
        "--sandbox-policy-cwd",
        root,
        "--command-cwd",
        root,
        "--permission-profile",
        JSON.stringify(workspaceWriteProfile(root, "enabled")),
        "--apply-seccomp-then-exec",
        "--allow-network-for-proxy",
        "--proxy-route-spec",
        prepared.serializedSpec,
        "--",
        "/bin/true",
      ], {
        env,
        preferredLauncher: () => ({ program: fakeBwrap, supportsArgv0: true }),
      });

      expect(exitCode).toBe(0);
      const recorded = JSON.parse(fs.readFileSync(capture, "utf8")) as {
        argv: string[];
        fd3Open: boolean;
      };
      expect(recorded.fd3Open).toBe(true);
      expect(recorded.argv).toContain("--seccomp");
      expect(recorded.argv).toContain(String(SECCOMP_STDIN_FD));
      const argv0Index = recorded.argv.indexOf("--argv0");
      expect(recorded.argv[argv0Index + 1]).toBe("/bin/true");
      expect(recorded.argv).toContain("/bin/true");
    } finally {
      prepared.cleanup();
    }
  });

  it("bridges managed proxy routes across host and sandbox namespace endpoints", async () => {
    const hostServer = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        socket.end(Buffer.concat([Buffer.from("echo:"), chunk]));
      });
    });
    await listenOn(hostServer, "127.0.0.1", 0);
    const address = hostServer.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("proxy test server did not bind to a TCP port");
    }
    const env = {
      ...process.env,
      HTTP_PROXY: `http://127.0.0.1:${address.port}`,
    };
    const prepared = await prepareHostProxyRoutes(env);
    const activated = await activateProxyRoutesInNetns(prepared.serializedSpec, env);
    try {
      const rewritten = new URL(activated.env.HTTP_PROXY ?? "");
      const response = await tcpRoundTrip(Number.parseInt(rewritten.port, 10), "hello");
      expect(rewritten.hostname).toBe("127.0.0.1");
      expect(response).toBe("echo:hello");
    } finally {
      activated.cleanup();
      prepared.cleanup();
      hostServer.close();
    }
  });

  it("destroys active managed proxy sockets during cleanup", async () => {
    const hostServer = net.createServer();
    await listenOn(hostServer, "127.0.0.1", 0);
    const address = hostServer.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("proxy cleanup server did not bind to a TCP port");
    }
    const env = {
      ...process.env,
      HTTP_PROXY: `http://127.0.0.1:${address.port}`,
    };
    const prepared = await prepareHostProxyRoutes(env);
    const activated = await activateProxyRoutesInNetns(prepared.serializedSpec, env);
    const rewritten = new URL(activated.env.HTTP_PROXY ?? "");
    const socket = net.connect({
      host: "127.0.0.1",
      port: Number.parseInt(rewritten.port, 10),
    });
    await onceSocket(socket, "connect");
    const closed = onceSocket(socket, "close");
    activated.cleanup();
    prepared.cleanup();
    hostServer.close();
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it("rejects malformed managed proxy route specs", async () => {
    const root = withTempDir("agenc-linux-launcher-bad-proxy-spec-");
    await expect(
      activateProxyRoutesInNetns(
        JSON.stringify({
          socketDir: root,
          routes: [{ envKey: "BAD_PROXY", udsPath: path.join(root, "x.sock") }],
        }),
        { BAD_PROXY: "http://127.0.0.1:3128" },
      ),
    ).rejects.toThrow(/unsupported env key/u);
    await expect(
      activateProxyRoutesInNetns(
        JSON.stringify({
          socketDir: root,
          routes: [{ envKey: "HTTP_PROXY", udsPath: path.join(path.dirname(root), "x.sock") }],
        }),
        { HTTP_PROXY: "http://127.0.0.1:3128" },
      ),
    ).rejects.toThrow(/must stay under socketDir/u);
  });

  it("masks host /proc with a tmpfs when proc is not mounted (full filesystem)", () => {
    const args = createBwrapCommandArgs(
      ["/bin/true"],
      unrestrictedFileSystemPolicy(),
      "/",
      "/",
      {
        mountProc: false,
        networkMode: "isolated",
        seccompFd: SECCOMP_STDIN_FD,
      },
    ).args;

    expect(procMaskIndex(args)).toBeGreaterThanOrEqual(0);
    // No fresh procfs mount and no unmasked host /proc bind survives.
    expect(args).not.toContain("--proc");
    expect(boundProcSources(args)).toEqual([]);
    // The tmpfs mask must land after the host root bind so it overrides it.
    expect(procMaskIndex(args)).toBeGreaterThan(rootBindIndex(args));
  });

  it("masks host /proc with a tmpfs when proc is not mounted (restricted policy)", () => {
    const root = withTempDir("agenc-linux-launcher-proc-mask-");
    const policy = restrictedFileSystemPolicy([
      { path: { kind: "path", path: root }, access: "write" },
    ]);

    const args = createBwrapCommandArgs(["/bin/true"], policy, root, root, {
      mountProc: false,
      networkMode: "isolated",
    }).args;

    expect(procMaskIndex(args)).toBeGreaterThanOrEqual(0);
    expect(args).not.toContain("--proc");
    expect(boundProcSources(args)).toEqual([]);
  });

  it("still mounts a private procfs (and no tmpfs mask) when proc is mounted", () => {
    const args = createBwrapCommandArgs(
      ["/bin/true"],
      unrestrictedFileSystemPolicy(),
      "/",
      "/",
      { mountProc: true, networkMode: "isolated", seccompFd: SECCOMP_STDIN_FD },
    ).args;

    expect(procMaskIndex(args)).toBe(-1);
    const procIndex = args.indexOf("--proc");
    expect(procIndex).toBeGreaterThanOrEqual(0);
    expect(args[procIndex + 1]).toBe("/proc");
  });

  it("treats genuine bubblewrap proc-mount errors as recoverable proc-mount failures", () => {
    expect(isProcMountFailure("bwrap: Can't mount proc on /proc")).toBe(true);
    expect(isProcMountFailure("bwrap: Can't mount new procfs: Operation not permitted")).toBe(
      true,
    );
  });

  it("does not false-positive on unrelated stderr mentioning proc or permissions", () => {
    expect(isProcMountFailure("error: permission denied opening /workspace/file")).toBe(false);
    expect(isProcMountFailure("bwrap: Operation not permitted")).toBe(false);
    expect(isProcMountFailure("python: process exited reading /proc/self/status")).toBe(false);
    expect(isProcMountFailure("bwrap: Can't open /proc")).toBe(false);
    expect(isProcMountFailure("Limit exceeded (ENOSPC). Check /proc/sys/fs/mount-max")).toBe(
      false,
    );
    expect(isProcMountFailure("")).toBe(false);
  });
});

function procMaskIndex(args: readonly string[]): number {
  return args.findIndex(
    (value, index) => value === "--tmpfs" && args[index + 1] === "/proc",
  );
}

function rootBindIndex(args: readonly string[]): number {
  return args.findIndex(
    (value, index) =>
      (value === "--bind" || value === "--ro-bind") &&
      args[index + 1] === "/" &&
      args[index + 2] === "/",
  );
}

function boundProcSources(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--bind" || flag === "--ro-bind" || flag === "--dev-bind") {
      const destination = args[index + 2];
      if (destination === "/proc" || destination === "/proc/") {
        result.push(args[index + 1] ?? "");
      }
    }
  }
  return result;
}

function workspaceWriteProfile(
  workspace: string,
  network: PermissionProfile["network"],
): PermissionProfile {
  return {
    fileSystem: restrictedFileSystemPolicy([
      { path: { kind: "path", path: workspace }, access: "write" },
    ]),
    network,
  };
}

function withTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function systemBubblewrapWorks(program: string): boolean {
  const output = spawnSync(program, [
    "--unshare-user",
    "--unshare-net",
    "--ro-bind",
    "/",
    "/",
    "--",
    "/bin/true",
  ]);
  return output.status === 0;
}

function sliceAfter(args: readonly string[], flag: string): string[] {
  const index = args.indexOf(flag);
  return index === -1 ? [] : args.slice(index + 1, index + 3);
}

function listenOn(server: net.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function tcpRoundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
    });
    socket.once("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function onceSocket(socket: net.Socket, event: "connect" | "close"): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once(event, () => {
      socket.off("error", reject);
      resolve();
    });
  });
}

function deniedSyscalls(program: Buffer): number[] {
  const denied: number[] = [];
  for (let offset = 0; offset + 15 < program.length; offset += 8) {
    const code = program.readUInt16LE(offset);
    const syscall = program.readUInt32LE(offset + 4);
    const nextCode = program.readUInt16LE(offset + 8);
    const nextValue = program.readUInt32LE(offset + 12);
    if (code === 0x15 && nextCode === 0x06 && nextValue === 0x00050001) {
      denied.push(syscall);
    }
  }
  return denied;
}
