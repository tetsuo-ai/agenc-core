import {
  spawn,
  spawnSync,
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { SandboxExecutionBroker, attachSandboxExecutionBroker } from "../../../src/sandbox/execution-broker.js";
import { createGlobTool } from "../../../src/tools/system/glob.js";
import { createGrepTool } from "../../../src/tools/system/grep.js";
import { ExecutionAdmissionKernel } from "../../../src/budget/execution-admission-kernel.js";
import { createHookExecutionAuthority } from "../../../src/hooks/execution-authority.js";
import { executeSessionStatusLine } from "../../../src/hooks/status-line-executor.js";
import { UnifiedExecProcessManager } from "../../../src/unified-exec/process-manager.js";
import { INHERITED_CWD_SANDBOX_PATH } from "../../../src/sandbox/linux-launcher/config.js";
import { findSystemBubblewrapInPath } from "../../../src/sandbox/linux-launcher/launcher.js";
import { bindWorkspaceDirectoryReadCapability, bindWorkspaceFileReadCapability, workspaceBoundReadOnlyCwd } from "../../../src/workspace/file-mutation-transaction.js";
import { workspaceMutationCoordinators } from "../../../src/workspace/mutation-coordinator.js";
import { createTestConfigStore, mkSession } from "../../fixtures.js";
import { captureWorktreeTurnEvidence, getOrCreateWorktree, removeAgentWorktree } from "../../../src/agents/worktree.js";

const runtimeRoot = fileURLToPath(new URL("../../../", import.meta.url));
const launcherEntry = join(runtimeRoot, "bin", "agenc-linux-sandbox");
const builtLauncher = join(
  runtimeRoot,
  "dist",
  "sandbox",
  "linux-launcher",
  "main.js",
);

test.each([["Glob", false], ["Grep", false], ["Glob", true], ["Grep", true]] as const)("runs production %s with narrow descriptor-bound read authority (exchange=%s)", { timeout: 30_000 }, async (name, exchange) => {
  const root = realpathSync(mkdtempSync("/var/tmp/agenc-narrow-search-kernel-"));
  const cwd = join(root, "workspace");
  const temporary = join(root, "temp");
  mkdirSync(cwd); mkdirSync(temporary);
  writeFileSync(join(cwd, "readable.txt"), "needle public\n");
  writeFileSync(join(root, "outside.txt"), "needle outside\n");
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "outside.txt"), "needle outside\n");
  const environment = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, AGENC_HOME: join(root, "home") };
  try {
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write", cwd, env: environment, sessionTempRoot: temporary,
      agencLinuxSandboxExe: launcherEntry,
      permissionProfile: { fileSystem: { kind: "restricted", includePlatformDefaults: true, entries: [
        { path: { kind: "path", path: cwd }, access: "write" },
        { path: { kind: "path", path: dirname(runtimeRoot) }, access: "read" },
        { path: { kind: "path", path: dirname(process.execPath) }, access: "read" },
        { path: { kind: "path", path: temporary }, access: "write" },
      ] }, network: "disabled" },
    });
    expect(broker.status().kind).toBe("ready");
    const config = { allowedPaths: [cwd], ...(exchange ? { __testAfterFinalPathCheck: async () => {
      renameSync(cwd, join(root, "displaced"));
      symlinkSync(outside, cwd, "dir");
    } } : {}) };
    const tool = name === "Glob" ? createGlobTool(config) : createGrepTool(config);
    const args: Record<string, unknown> = { pattern: name === "Glob" ? "*.txt" : "needle", path: cwd, includeIgnored: true, ...(name === "Grep" ? { output_mode: "content" } : {}) };
    attachSandboxExecutionBroker(args, broker);
    const result = await tool.execute(args);
    expect(result.isError, result.content).not.toBe(true);
    expect(result.content).toContain("readable.txt");
    expect(result.content).not.toContain("outside.txt");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(["Glob", "Grep"] as const)("refuses unsupported narrow %s read-deny policy before dispatch", { timeout: 30_000 }, async (name) => {
  const root = realpathSync(mkdtempSync("/var/tmp/agenc-narrow-deny-kernel-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "secret.txt"), "needle confidential\n");
  try {
    for (const deny of [
      { kind: "path" as const, path: join(cwd, "secret.txt") },
      { kind: "glob" as const, pattern: join(cwd, "*.txt") },
    ]) {
      const broker = new SandboxExecutionBroker({ mode: "workspace_write", cwd,
        env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, AGENC_HOME: join(root, "home") }, agencLinuxSandboxExe: launcherEntry,
        permissionProfile: { fileSystem: { kind: "restricted", includePlatformDefaults: true, entries: [
          { path: { kind: "path", path: cwd }, access: "write" },
          { path: { kind: "path", path: dirname(runtimeRoot) }, access: "read" },
          { path: { kind: "path", path: dirname(process.execPath) }, access: "read" },
          { path: deny, access: "none" },
        ] }, network: "disabled" },
      });
      const tool = name === "Glob" ? createGlobTool({ allowedPaths: [cwd] }) : createGrepTool({ allowedPaths: [cwd] });
      const args: Record<string, unknown> = { pattern: name === "Glob" ? "*.txt" : "needle", path: cwd, includeIgnored: true };
      attachSandboxExecutionBroker(args, broker);
      await expect(tool.execute(args)).rejects.toThrow("cannot represent read-deny or glob policy entries");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects copied, forged, revoked, exact-file and mismatched cwd capabilities before payload execution", { timeout: 30_000 }, async () => {
  const root = realpathSync(mkdtempSync("/var/tmp/agenc-narrow-capability-kernel-"));
  const cwd = join(root, "workspace");
  const foreign = join(root, "foreign");
  mkdirSync(cwd); mkdirSync(foreign);
  writeFileSync(join(cwd, "file.txt"), "content");
  writeFileSync(join(foreign, "secret.txt"), "outside-secret");
  const environment = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, AGENC_HOME: join(root, "home") };
  const capability = await bindWorkspaceDirectoryReadCapability(cwd);
  const other = await bindWorkspaceDirectoryReadCapability(foreign);
  const file = await bindWorkspaceFileReadCapability(join(cwd, "file.txt"));
  try {
    const broker = new SandboxExecutionBroker({ mode: "workspace_write", cwd, env: environment, agencLinuxSandboxExe: launcherEntry,
      permissionProfile: { fileSystem: { kind: "restricted", includePlatformDefaults: true, entries: [
        { path: { kind: "path", path: cwd }, access: "write" },
        { path: { kind: "path", path: dirname(runtimeRoot) }, access: "read" },
        { path: { kind: "path", path: dirname(process.execPath) }, access: "read" },
      ] }, network: "disabled" },
    });
    const token = workspaceBoundReadOnlyCwd(capability)!;
    expect(token).toBeDefined();
    const command = { program: process.execPath, args: ["--input-type=module", "--eval", "import fs from 'node:fs';fs.writeFileSync('payload-ran','unexpected');"], cwd: ".", cwdBinding: "inherited_readonly" as const, env: environment };
    expect(() => broker.prepareSpawn("tool", { ...command, cwdCapability: workspaceBoundReadOnlyCwd(other) })).toThrow("not wholly covered");
    for (const invalid of [{ ...token }, { path: cwd, dev: "1", ino: "1", mode: "16832" }, workspaceBoundReadOnlyCwd(file)]) {
      expect(() => broker.prepareSpawn("tool", { ...command, cwdCapability: invalid as never })).toThrow("current source-owned directory capability");
    }
    const confined = await broker.prepareSpawn("tool", { ...command, cwdCapability: token, args: [
      "--input-type=module", "--eval", `
        import fs from 'node:fs';
        const attempt = fn => { try { fn(); return 'ALLOWED'; } catch (error) { return error.code; } };
        process.stdout.write(JSON.stringify({
          inside: fs.readFileSync('file.txt', 'utf8'),
          write: attempt(() => fs.writeFileSync('payload-ran', 'unexpected')),
          outside: attempt(() => fs.readFileSync(process.argv[1])),
          publicCwd: attempt(() => fs.readFileSync(process.argv[2])),
        }));
      `, join(foreign, "secret.txt"), join(cwd, "file.txt"),
    ] }).run(resolved => capability.runRipgrep({
      program: resolved.program, args: resolved.args, env: resolved.env, argv0: resolved.argv0, timeoutMs: 10_000, maxOutputBytes: 16 * 1024,
    }));
    expect(confined.exitCode, confined.stderr.toString()).toBe(0);
    const confinedEvidence = JSON.parse(confined.stdout.toString());
    expect(confinedEvidence.inside).toBe("content");
    for (const key of ["write", "outside", "publicCwd"]) expect(confinedEvidence[key], JSON.stringify(confinedEvidence)).not.toBe("ALLOWED");
    const mismatch = await broker.prepareSpawn("tool", { ...command, cwdCapability: token }).run(resolved => other.runRipgrep({
      program: resolved.program, args: resolved.args, env: resolved.env, argv0: resolved.argv0, timeoutMs: 10_000, maxOutputBytes: 16 * 1024,
    }));
    expect(mismatch.exitCode).not.toBe(0);
    expect(mismatch.stderr.toString()).toContain("descriptor identity changed");
    expect(existsSync(join(foreign, "payload-ran"))).toBe(false);
    const disposing = capability.dispose();
    expect(() => broker.prepareSpawn("tool", { ...command, cwdCapability: token })).toThrow("current source-owned directory capability");
    await disposing;
    expect(existsSync(join(cwd, "payload-ran"))).toBe(false);
  } finally {
    await Promise.all([capability.dispose(), other.dispose(), file.dispose()]);
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])("supports an aliased command cwd without expanding filesystem access (narrow=%s)", { timeout: 30_000 }, async (narrow) => {
  const root = realpathSync(mkdtempSync(join("/var/tmp", "agenc-alias-cwd-kernel-")));
  const physical = join(root, "real", "project");
  const alias = join(root, "alias");
  const chainedAlias = join(root, "alias-again");
  const cwd = join(chainedAlias, "project");
  const temporary = join(root, "temp");
  const outside = join(root, "real", "ungranted.txt");
  mkdirSync(join(physical, ".git"), { recursive: true });
  mkdirSync(temporary);
  symlinkSync(join(root, "real"), alias, "dir");
  symlinkSync("alias", chainedAlias, "dir");
  writeFileSync(join(physical, "readable.txt"), "readable");
  writeFileSync(join(physical, "locked.txt"), "locked");
  writeFileSync(join(physical, "secret.txt"), "secret");
  writeFileSync(join(physical, ".git", "config"), "protected");
  writeFileSync(outside, "outside");
  const environment = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, AGENC_HOME: join(root, "home") };
  try {
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write", cwd, env: environment, sessionTempRoot: temporary,
      agencLinuxSandboxExe: launcherEntry,
      permissionProfile: {
        fileSystem: { kind: "restricted", includePlatformDefaults: true, entries: [
          ...(!narrow ? [{ path: { kind: "special" as const, value: { kind: "root" as const } }, access: "read" as const }] : []),
          { path: { kind: "path", path: cwd }, access: "write" },
          { path: { kind: "path", path: temporary }, access: "write" },
          { path: { kind: "path", path: join(runtimeRoot, "node_modules") }, access: "read" },
          { path: { kind: "path", path: join(dirname(runtimeRoot), "node_modules") }, access: "read" },
          { path: { kind: "path", path: join(cwd, "locked.txt") }, access: "read" },
          { path: { kind: "path", path: join(cwd, "secret.txt") }, access: "none" },
        ] },
        network: "disabled",
      },
    });
    const result = await broker.prepareSpawn("tool", {
      program: process.execPath,
      args: ["--input-type=module", "--eval", `
        import fs from 'node:fs';
        const [alias, outside] = process.argv.slice(1);
        const attempt = (fn) => { try { fn(); return 'ALLOWED'; } catch (error) { return error.code; } };
        process.stdout.write(JSON.stringify({
          cwd: process.cwd(),
          readable: fs.readFileSync('readable.txt', 'utf8'),
          relativeWrite: attempt(() => fs.writeFileSync('relative.txt', 'relative')),
          aliasWrite: attempt(() => fs.writeFileSync(alias + '/absolute.txt', 'absolute')),
          lockedWrite: attempt(() => fs.writeFileSync('locked.txt', 'forged')),
          secretRead: attempt(() => fs.readFileSync('secret.txt')),
          metadataWrite: attempt(() => fs.writeFileSync('.git/config', 'forged')),
          outsideRead: attempt(() => fs.readFileSync(outside)),
          outsideWrite: attempt(() => fs.writeFileSync(outside, 'forged')),
        }));
      `, cwd, outside],
      cwd, env: environment,
    }).run(async (command) => spawnSync(command.program, [...command.args], {
      cwd: command.cwd, env: command.env, encoding: "utf8", timeout: 10_000,
    }));
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout);
    expect(evidence).toMatchObject({ cwd: physical, readable: "readable", relativeWrite: "ALLOWED", aliasWrite: "ALLOWED" });
    for (const key of ["lockedWrite", "secretRead", "metadataWrite"]) {
      expect(evidence[key], JSON.stringify(evidence)).not.toBe("ALLOWED");
    }
    if (narrow) {
      expect(evidence.outsideRead).not.toBe("ALLOWED");
      // The private tmpfs may accept a new file at this spelling. It must
      // neither reveal nor overwrite the host file, checked below.
    } else {
      expect(evidence.outsideWrite).not.toBe("ALLOWED");
    }
    expect(readFileSync(join(physical, "relative.txt"), "utf8")).toBe("relative");
    expect(readFileSync(join(physical, "absolute.txt"), "utf8")).toBe("absolute");
    expect(readFileSync(join(physical, "locked.txt"), "utf8")).toBe("locked");
    expect(readFileSync(join(physical, ".git", "config"), "utf8")).toBe("protected");
    expect(readFileSync(outside, "utf8")).toBe("outside");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removes a verified clean worktree without a deletion-target mount or peer damage", { timeout: 30_000 }, async () => {
  expect(process.platform).toBe("linux");
  const root = realpathSync(mkdtempSync(join("/var/tmp", "agenc-remove-worktree-kernel-")));
  const project = join(root, "project");
  const temporary = join(root, "temp");
  mkdirSync(project);
  mkdirSync(temporary);
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: project, encoding: "utf8" }).trim();
  try {
    git(["init", "-q"]);
    writeFileSync(join(project, "tracked.txt"), "preserved sibling\n");
    git(["add", "tracked.txt"]);
    git(["-c", "user.name=AgenC Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "seed"]);
    const baseCommit = git(["rev-parse", "HEAD"]);
    const broker = new SandboxExecutionBroker({ mode: "workspace_write", cwd: project, sessionTempRoot: temporary, agencLinuxSandboxExe: launcherEntry });
    expect(broker.status().kind).toBe("ready");
    const target = await getOrCreateWorktree({ gitRoot: project, slug: "target", sandboxExecutionBroker: broker });
    const sibling = await getOrCreateWorktree({ gitRoot: project, slug: "sibling", sandboxExecutionBroker: broker });
    const evidence = await captureWorktreeTurnEvidence({ locator: target, baseCommit, sandboxExecutionBroker: broker });
    expect(evidence.state).toBe("unchanged_clean");
    const admin = readFileSync(join(target.path, ".git"), "utf8").trim().slice("gitdir: ".length);
    await removeAgentWorktree({ ...target, sandboxExecutionBroker: broker });
    expect(existsSync(target.path)).toBe(false);
    expect(existsSync(admin)).toBe(false);
    expect(readFileSync(join(sibling.path, "tracked.txt"), "utf8")).toBe("preserved sibling\n");
    expect(git(["worktree", "list", "--porcelain"])).toContain(sibling.path);
    mkdirSync(join(root, "external-worktrees"));
    const external = await getOrCreateWorktree({ gitRoot: project, slug: "external", workspaceRoot: join(root, "external-worktrees"), sandboxExecutionBroker: broker });
    const externalMarker = readFileSync(join(external.path, ".git"), "utf8");
    await expect(removeAgentWorktree({ ...external, sandboxExecutionBroker: broker })).rejects.toThrow(/existing workspace write authority/u);
    expect(readFileSync(join(external.path, "tracked.txt"), "utf8")).toBe("preserved sibling\n");
    expect(readFileSync(join(external.path, ".git"), "utf8")).toBe(externalMarker);
    expect(existsSync(externalMarker.trim().slice("gitdir: ".length))).toBe(true);

    const protectedBroker = new SandboxExecutionBroker({ mode: "workspace_write", cwd: project, sessionTempRoot: temporary, agencLinuxSandboxExe: launcherEntry,
      permissionProfile: { fileSystem: { kind: "restricted", entries: [
        { path: { kind: "special", value: { kind: "root" } }, access: "read" },
        { path: { kind: "path", path: project }, access: "write" },
        { path: { kind: "path", path: join(sibling.path, "tracked.txt") }, access: "read" },
      ] }, network: "disabled" },
    });
    await expect(removeAgentWorktree({ ...sibling, sandboxExecutionBroker: protectedBroker })).rejects.toThrow(/sandbox mount or protected path/u);
    expect(readFileSync(join(sibling.path, "tracked.txt"), "utf8")).toBe("preserved sibling\n");
    const siblingMarker = readFileSync(join(sibling.path, ".git"), "utf8");
    writeFileSync(join(sibling.path, ".git"), `gitdir: ${join(root, "foreign-metadata")}\n`);
    await expect(removeAgentWorktree({ ...sibling, sandboxExecutionBroker: broker })).rejects.toThrow(/refused before mutation/u);
    expect(readFileSync(join(sibling.path, "tracked.txt"), "utf8")).toBe("preserved sibling\n");
    expect(existsSync(siblingMarker.trim().slice("gitdir: ".length))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renders a status command with ordinary workspace-write isolation and a captured system PATH", { timeout: 30_000 }, async () => {
  expect(process.platform).toBe("linux");
  const home = realpathSync(mkdtempSync(join("/var/tmp", "agenc-status-kernel-")));
  const cwd = join(home, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const environment = { PATH: "/usr/bin:/bin", HOME: home, AGENC_HOME: home };
  const kernel = new ExecutionAdmissionKernel({ agencHome: home });
  try {
    expect(findSystemBubblewrapInPath(environment.PATH)).toBe("/usr/bin/bwrap");
    const admission = kernel.bindClient({ cwd, scope: { runId: "conv-test", sessionId: "conv-test", autonomous: false } });
    const configStore = createTestConfigStore({ cwd, base: {
      statusLine: { type: "command", command: "printf ordinary-sandbox-status" },
    } });
    await configStore.reload();
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd,
      env: environment,
      sessionTempRoot: home,
      agencLinuxSandboxExe: launcherEntry,
    });
    expect(broker.status().kind).toBe("ready");
    const { session } = mkSession({
      cwd,
      services: {
        configStore,
        executionAdmission: admission,
        sandboxExecutionBroker: broker,
        hookExecutionAuthority: createHookExecutionAuthority({
          runtimeOptions: { simpleMode: false, allowUntrustedHooks: false },
          isWorkspaceTrusted: () => true,
        }),
        userShell: {
          path: "/bin/sh",
          commandWrapperArgv: [],
          childEnvironment: environment,
          deriveExecArgs: (command) => ["-c", command],
        },
      },
    });
    expect(await executeSessionStatusLine(session))
      .toEqual({ status: "rendered", text: "ordinary-sandbox-status" });
    expect(admission.replayJournal?.().map((event) => event.event)).not.toContain("held_unknown");
  } finally {
    kernel.close();
    workspaceMutationCoordinators.clearForTests();
    rmSync(home, { recursive: true, force: true });
  }
});

test("sandboxed zsh heredocs use captured temp authority while general tmp stays read-only", { timeout: 30_000 }, async () => {
  const root = realpathSync(mkdtempSync(join("/var/tmp", "agenc-zsh-kernel-")));
  const workspace = join(root, "workspace");
  const sessionTempRoot = join(root, "temporary files");
  mkdirSync(workspace);
  mkdirSync(sessionTempRoot);
  const environment = {
    ...stringEnvironment(process.env),
    TMPPREFIX: "/tmp/untrusted-zsh",
    TmPpReFiX: "/tmp/mixed-zsh",
  };
  const broker = new SandboxExecutionBroker({
    mode: "workspace_write",
    cwd: workspace,
    env: environment,
    sessionTempRoot,
    agencLinuxSandboxExe: launcherEntry,
  });
  const manager = new UnifiedExecProcessManager({ cwd: workspace, baseEnv: environment, sessionTempRoot });
  const blockedPath = `/tmp/agenc-zsh-denied-${randomUUID()}`;
  try {
    expect(broker.status().kind).toBe("ready");
    const payload = "heredoc-data-".repeat(1000);
    const result = await manager.execCommand({
      shell: "/bin/zsh",
      login: false,
      cmd: `printf '%s\\n' "$TMPPREFIX"\ncat <<'AGENC_DATA'\n${payload}\nAGENC_DATA\nif printf forbidden > '${blockedPath}'; then exit 91; fi`,
      runtimeSandbox: broker.runtimeSandbox("tool"),
      yield_time_ms: 10_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${sessionTempRoot}/zsh\n${payload}\n`);
    expect(result.stderr).toMatch(/read-only file system|read-only filesystem|permission denied/iu);
    expect(existsSync(blockedPath)).toBe(false);
  } finally {
    await manager.closeAll("test_cleanup");
    rmSync(root, { recursive: true, force: true });
    rmSync(blockedPath, { force: true });
  }
});

test("protects custom Desktop authority records and their ancestor namespace with the real Linux kernel", { timeout: 30_000 }, async () => {
  expect(process.platform).toBe("linux");
  const workspace = realpathSync(mkdtempSync(join("/var/tmp", "agenc-authority-kernel-")));
  const home = join(workspace, "nested", "custom-agent-state");
  const authority = join(home, "desktop-control-authorities");
  const record = join(authority, "public.json");
  const temp = join(workspace, "temp");
  mkdirSync(authority, { recursive: true, mode: 0o700 });
  mkdirSync(temp);
  writeFileSync(record, "native-public-record");
  const alias = join(workspace, "alias");
  symlinkSync(authority, alias);
  try {
    const environment = { ...stringEnvironment(process.env), AGENC_HOME: home };
    const broker = new SandboxExecutionBroker({ mode: "workspace_write", cwd: workspace, env: environment,
      sessionTempRoot: temp, agencLinuxSandboxExe: launcherEntry });
    expect(broker.status().kind).toBe("ready");
    for (const cwd of [workspace, home, authority]) {
      const result = await broker.prepareSpawn("tool", {
        program: process.execPath,
        args: ["--input-type=module", "--eval", `
          import fs from 'node:fs';
          const [record, alias, home, ancestor, allowed] = process.argv.slice(1);
          const attempt = (fn) => { try { fn(); return 'ALLOWED'; } catch(e) { return e.code; } };
          const result = {
            overwrite: attempt(() => fs.writeFileSync(record, 'forged')),
            create: attempt(() => fs.writeFileSync(alias + '/new.json', 'forged')),
            unlink: attempt(() => fs.unlinkSync(record)),
            hardlink: attempt(() => fs.linkSync(record, allowed + '.link')),
            homeMove: attempt(() => fs.renameSync(home, home + '-moved')),
            ancestorMove: attempt(() => fs.renameSync(ancestor, ancestor + '-moved')),
            normal: attempt(() => fs.writeFileSync(allowed, 'allowed')),
          };
          process.stdout.write(JSON.stringify(result));
        `, record, alias, home, dirname(home), join(workspace, "allowed.txt")],
        cwd, env: { ...environment, AGENC_HOME: join(workspace, "untrusted-command-home") },
        additionalPermissions: { fileSystem: { entries: [
          { path: { kind: "path", path: authority }, access: "write" },
          { path: { kind: "path", path: record }, access: "write" },
        ] } },
      }).run(async command => spawnSync(command.program, [...command.args], {
        cwd: command.cwd, env: command.env, encoding: "utf8", timeout: 8_000,
      }));
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      for (const key of ["overwrite", "create", "unlink", "hardlink", "homeMove", "ancestorMove"]) expect(evidence[key], JSON.stringify(evidence)).not.toBe("ALLOWED");
      expect(evidence.normal).toBe("ALLOWED");
      expect(readFileSync(record, "utf8")).toBe("native-public-record");
      expect(existsSync(join(authority, "new.json"))).toBe(false);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test(
  "enforces the production Linux sandbox boundary with the real kernel",
  { timeout: 30_000 },
  async () => {
    expect(process.platform).toBe("linux");
    expect(typeof process.getuid).toBe("function");
    expect(process.getuid!()).toBeGreaterThan(0);
    expect(effectiveCapabilities()).toBe(0n);
    expect(existsSync(launcherEntry), launcherEntry).toBe(true);
    expect(existsSync(builtLauncher), builtLauncher).toBe(true);

    const bubblewrap = findSystemBubblewrapInPath(process.env.PATH, process.cwd());
    expect(bubblewrap).toBe("/usr/bin/bwrap");
    const version = spawnSync(bubblewrap!, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(
      version.status,
      `bubblewrap version probe failed\nstdout=${version.stdout}\nstderr=${version.stderr}`,
    ).toBe(0);
    expect(version.stdout.trim()).toMatch(/^bubblewrap \d+\.\d+\.\d+$/u);

    const token = `agenc-kernel-e2e-${randomUUID()}`;
    const root = mkdtempSync(join("/var/tmp", "agenc-kernel-e2e-"));
    const workspace = join(root, "workspace");
    const hostReadOnlyDirectory = join(root, "host-read-only");
    const hostSentinel = join(hostReadOnlyDirectory, "sentinel.txt");
    const hostCreate = join(hostReadOnlyDirectory, "created.txt");
    const allowedWrite = join(workspace, "allowed.txt");
    const evidencePath = join(workspace, "evidence.json");
    const descendantReadyMarker = join(workspace, "descendant-ready.txt");
    const descendantLeakMarker = join(workspace, "descendant-leak.txt");
    const launcherSentinel = join(runtimeRoot, "dist", `.${token}.sentinel`);
    const launcherCreate = join(runtimeRoot, "dist", `.${token}.created`);
    mkdirSync(workspace, { mode: 0o700 });
    mkdirSync(hostReadOnlyDirectory, { mode: 0o700 });
    writeFileSync(hostSentinel, "host-read-only", { mode: 0o600 });
    writeFileSync(launcherSentinel, "launcher-read-only", { mode: 0o600 });

    const server = createServer();
    let hostConnections = 0;
    let hostPayloads: string[] = [];
    server.on("connection", (socket) => {
      hostConnections += 1;
      socket.setTimeout(2_000, () => socket.destroy());
      socket.once("data", (chunk) => {
        hostPayloads.push(chunk.toString("utf8"));
        socket.end("host-network-visible");
      });
    });

    let launcher: ChildProcessWithoutNullStreams | undefined;
    try {
      await listen(server);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("kernel capability server did not bind a TCP port");
      }

      const baselineToken = `baseline-${token}`;
      await expect(tcpRoundTrip(address.port, baselineToken)).resolves.toBe(
        "host-network-visible",
      );
      expect(hostConnections).toBe(1);
      expect(hostPayloads).toEqual([baselineToken]);
      hostConnections = 0;
      hostPayloads = [];

      const childEnv = stringEnvironment(process.env);
      delete childEnv.NODE_OPTIONS;
      delete childEnv.AGENC_TEST_NETWORK_ATTEMPT_LEDGER;
      const broker = new SandboxExecutionBroker({
        mode: "workspace_write",
        cwd: workspace,
        env: childEnv,
        agencLinuxSandboxExe: launcherEntry,
      });
      const status = broker.status();
      expect(status, JSON.stringify(status, null, 2)).toMatchObject({
        kind: "ready",
        mode: "workspace_write",
        platform: "linux",
        helperPath: realpathSync(launcherEntry),
        isolationProgram: "/usr/bin/bwrap",
      });
      expect(
        readFileSync("/proc/self/attr/current", "utf8").trim(),
      ).toBe("agenc-native-userns (unconfined)");

      // AppArmor may transition /usr/bin/bwrap and stack its child under the
      // distro's unpriv_bwrap profile. Measure that transition independently
      // of AgenC, using the same parent profile and child executable.
      const profileProbe = spawnSync(bubblewrap!, [
        "--die-with-parent", "--new-session",
        "--unshare-user", "--unshare-pid", "--unshare-net",
        "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
        "--", process.execPath, "--input-type=module", "--eval",
        'import { readFileSync } from "node:fs"; process.stdout.write(readFileSync("/proc/self/attr/current", "utf8"));',
      ], {
        cwd: workspace,
        env: childEnv,
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 4_096,
      });
      const profileDiagnostics = `direct bubblewrap AppArmor probe: ${JSON.stringify({
        status: profileProbe.status,
        signal: profileProbe.signal,
        error: profileProbe.error?.message,
        stdout: profileProbe.stdout,
        stderr: profileProbe.stderr,
      })}`;
      expect(profileProbe.error, profileDiagnostics).toBeUndefined();
      expect(profileProbe.signal, profileDiagnostics).toBeNull();
      expect(profileProbe.status, profileDiagnostics).toBe(0);
      const expectedAppArmorProfile = profileProbe.stdout.trim();
      expect([
        "agenc-native-userns (unconfined)",
        "bwrap//&unpriv_bwrap (enforce)",
      ], profileDiagnostics).toContain(expectedAppArmorProfile);

      const payload = Buffer.from(
        JSON.stringify({
          allowedWrite,
          expectedAppArmorProfile,
          descendantLeakMarker,
          descendantReadyMarker,
          descendantScript: Buffer.from(
            descendantProbeScript(),
            "utf8",
          ).toString("base64"),
          evidencePath,
          host: "127.0.0.1",
          hostCreate,
          hostSentinel,
          launcherCreate,
          launcherSentinel,
          port: address.port,
          token,
        }),
        "utf8",
      ).toString("base64");
      const { command: prepared, result } = await broker
        .prepareSpawn("tool", {
          program: process.execPath,
          args: [
            "--input-type=module",
            "--eval",
            kernelProbeScript(),
            payload,
          ],
          cwd: workspace,
          env: childEnv,
        })
        .run(async (command) => {
          expect(command.program).toBe(realpathSync(process.execPath));
          expect(command.args[0]).toBe(realpathSync(launcherEntry));
          expect(command.args).toContain("--permission-profile");
          expect(command.args).toContain("--");

          const child = spawn(command.program, [...command.args], {
            cwd: command.cwd,
            env: command.env,
            argv0: command.argv0,
            stdio: ["pipe", "pipe", "pipe"],
          });
          launcher = child;
          child.stdin.end();
          return {
            command,
            result: await waitForProcess(child, 20_000),
          };
        });
      const diagnostics = [
        `bubblewrap=${bubblewrap}`,
        `version=${version.stdout.trim()}`,
        profileDiagnostics,
        `broker=${JSON.stringify(status)}`,
        `prepared=${JSON.stringify({
          program: prepared.program,
          args: prepared.args,
          cwd: prepared.cwd,
          argv0: prepared.argv0,
        })}`,
        `status=${String(result.code)}`,
        `signal=${String(result.signal)}`,
        `timedOut=${String(result.timedOut)}`,
        `stdout=${JSON.stringify(result.stdout)}`,
        `stderr=${JSON.stringify(result.stderr)}`,
        `evidence=${existsSync(evidencePath) ? readFileSync(evidencePath, "utf8") : "missing"}`,
      ].join("\n");

      expect(result.timedOut, diagnostics).toBe(false);
      expect(result.signal, diagnostics).toBeNull();
      expect(result.code, diagnostics).toBe(0);
      expect(existsSync(evidencePath), diagnostics).toBe(true);

      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
        readonly allowedWrite: boolean;
        readonly appArmorProfile: string;
        readonly descendant: {
          readonly ready: boolean;
          readonly visibleInProc: boolean;
        };
        readonly hostReadOnly: {
          readonly content: string | null;
          readonly createError: string | null;
          readonly visible: boolean;
          readonly writeError: string | null;
        };
        readonly launcherRoot: {
          readonly content: string | null;
          readonly createError: string | null;
          readonly writeError: string | null;
        };
        readonly network: {
          readonly blocked: boolean;
          readonly error: string | null;
        };
        readonly namespaces: {
          readonly mnt: string;
          readonly net: string;
          readonly pid: string;
          readonly user: string;
        };
      };
      expect(evidence.allowedWrite).toBe(true);
      expect(evidence.appArmorProfile).toBe(expectedAppArmorProfile);
      expect(readFileSync(allowedWrite, "utf8")).toBe("workspace-write-ok");
      expect(evidence.hostReadOnly).toEqual({
        content: "host-read-only",
        createError: "EROFS",
        visible: true,
        writeError: "EROFS",
      });
      expect(readFileSync(hostSentinel, "utf8")).toBe("host-read-only");
      expect(existsSync(hostCreate)).toBe(false);
      expect(evidence.launcherRoot).toEqual({
        content: "launcher-read-only",
        createError: "EROFS",
        writeError: "EROFS",
      });
      expect(readFileSync(launcherSentinel, "utf8")).toBe("launcher-read-only");
      expect(existsSync(launcherCreate)).toBe(false);
      expect(evidence.network).toEqual({ blocked: true, error: "EPERM" });
      expect(evidence.namespaces.mnt).not.toBe(readlinkSync("/proc/self/ns/mnt"));
      expect(evidence.namespaces.net).not.toBe(readlinkSync("/proc/self/ns/net"));
      expect(evidence.namespaces.pid).not.toBe(readlinkSync("/proc/self/ns/pid"));
      expect(evidence.namespaces.user).not.toBe(readlinkSync("/proc/self/ns/user"));
      expect(evidence.descendant).toEqual({
        ready: true,
        visibleInProc: true,
      });
      expect(readFileSync(descendantReadyMarker, "utf8")).toBe(token);

      await new Promise((resolve) => setImmediate(resolve));
      expect(hostConnections).toBe(0);
      expect(hostPayloads).toEqual([]);
      await waitForNoProcessToken(token, 2_000);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(existsSync(descendantLeakMarker)).toBe(false);
      expect(processesContaining(token)).toEqual([]);
      expect(hostConnections).toBe(0);
      expect(hostPayloads).toEqual([]);
    } finally {
      await terminateProcess(launcher);
      killProcessesContaining(token);
      await waitUntilNoProcessToken(token, 2_000);
      await closeServer(server);
      rmSync(root, { force: true, recursive: true });
      rmSync(launcherSentinel, { force: true });
      rmSync(launcherCreate, { force: true });
    }
  },
);

test(
  "keeps descriptor-bound tool cwd read-only across a workspace exchange",
  { timeout: 20_000 },
  async () => {
    expect(process.platform).toBe("linux");
    expect(existsSync(launcherEntry), launcherEntry).toBe(true);
    expect(existsSync(builtLauncher), builtLauncher).toBe(true);
    const root = mkdtempSync(join("/var/tmp", "agenc-kernel-bound-cwd-"));
    const boundWorkspace = join(root, "workspace");
    const displacedWorkspace = join(root, "workspace-displaced");
    const outsideWorkspace = join(root, "workspace-outside");
    const outsideWrite = join(outsideWorkspace, "outside-write.txt");
    mkdirSync(boundWorkspace, { mode: 0o700 });
    mkdirSync(outsideWorkspace, { mode: 0o700 });
    writeFileSync(join(boundWorkspace, "sentinel.txt"), "bound-inside", {
      mode: 0o600,
    });
    writeFileSync(join(outsideWorkspace, "sentinel.txt"), "outside", {
      mode: 0o600,
    });
    const childEnv = stringEnvironment(process.env);
    delete childEnv.NODE_OPTIONS;
    const boundCapability = await bindWorkspaceDirectoryReadCapability(
      boundWorkspace,
    );
    try {
      const boundBroker = new SandboxExecutionBroker({
        mode: "workspace_write",
        cwd: boundWorkspace,
        env: childEnv,
        agencLinuxSandboxExe: launcherEntry,
      });
      const status = boundBroker.status();
      expect(status, JSON.stringify(status, null, 2)).toMatchObject({
        kind: "ready",
        mode: "workspace_write",
        platform: "linux",
      });
      const boundResult = await boundBroker
        .prepareSpawn("tool", {
          program: process.execPath,
          args: [
            "--input-type=module",
            "--eval",
            descriptorBoundProbeScript(),
            Buffer.from(
              JSON.stringify({ originalWorkspace: boundWorkspace }),
              "utf8",
            ).toString("base64"),
          ],
          cwd: ".",
          cwdBinding: "inherited_readonly",
          env: childEnv,
        })
        .run(async (command) => {
          expect(command.args).toContain(
            "--inherited-readonly-command-cwd",
          );
          expect(command.args).not.toContain(boundWorkspace);

          renameSync(boundWorkspace, displacedWorkspace);
          symlinkSync(outsideWorkspace, boundWorkspace, "dir");
          return boundCapability.runRipgrep({
            program: command.program,
            args: command.args,
            env: command.env,
            ...(command.argv0 === undefined
              ? {}
              : { argv0: command.argv0 }),
            timeoutMs: 10_000,
            maxOutputBytes: 16 * 1024,
          });
        });
      const boundDiagnostics = [
        `exit=${String(boundResult.exitCode)}`,
        `signal=${String(boundResult.signal)}`,
        `stopReason=${String(boundResult.stopReason)}`,
        `spawnError=${String(boundResult.spawnError)}`,
        `stdout=${JSON.stringify(boundResult.stdout.toString("utf8"))}`,
        `stderr=${JSON.stringify(boundResult.stderr.toString("utf8"))}`,
      ].join("\n");
      expect(boundResult.spawnError, boundDiagnostics).toBeUndefined();
      expect(boundResult.stopReason, boundDiagnostics).toBeUndefined();
      expect(boundResult.exitCode, boundDiagnostics).toBe(0);
      expect(boundResult.stdout.byteLength, boundDiagnostics).toBeGreaterThan(0);
      const boundEvidence = JSON.parse(
        boundResult.stdout.toString("utf8"),
      ) as {
        readonly cwd: string;
        readonly relativeCreateError: string | null;
        readonly retargetCreateError: string | null;
        readonly sentinel: string;
      };
      expect(boundEvidence).toEqual({
        cwd: INHERITED_CWD_SANDBOX_PATH,
        relativeCreateError: "EROFS",
        retargetCreateError: "EROFS",
        sentinel: "bound-inside",
      });
      expect(existsSync(outsideWrite)).toBe(false);
    } finally {
      try {
        await boundCapability.dispose();
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    }
  },
);

function descriptorBoundProbeScript(): string {
  return `
    import { readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";

    const payload = JSON.parse(
      Buffer.from(process.argv[1], "base64").toString("utf8"),
    );
    const attemptCreate = (path) => {
      try {
        writeFileSync(path, "unexpected-write");
        return null;
      } catch (error) {
        return typeof error?.code === "string" ? error.code : String(error);
      }
    };
    writeFileSync(process.stdout.fd, JSON.stringify({
      cwd: process.cwd(),
      relativeCreateError: attemptCreate("relative-write.txt"),
      retargetCreateError: attemptCreate(
        join(payload.originalWorkspace, "outside-write.txt"),
      ),
      sentinel: readFileSync("sentinel.txt", "utf8"),
    }));
  `;
}

function kernelProbeScript(): string {
  return `
    import { spawn } from "node:child_process";
    import {
      existsSync,
      readFileSync,
      readdirSync,
      readlinkSync,
      writeFileSync,
    } from "node:fs";
    import { connect } from "node:net";
    import { join } from "node:path";

    const payload = JSON.parse(
      Buffer.from(process.argv[1], "base64").toString("utf8"),
    );

    function errorCode(error) {
      return typeof error?.code === "string" ? error.code : String(error);
    }

    function attemptWrite(path, value) {
      try {
        writeFileSync(path, value);
        return null;
      } catch (error) {
        return errorCode(error);
      }
    }

    function networkProbe() {
      return new Promise((resolve) => {
        let settled = false;
        const socket = connect({ host: payload.host, port: payload.port });
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(result);
        };
        const timer = setTimeout(
          () => finish({ blocked: false, error: "timeout" }),
          1500,
        );
        socket.once("connect", () => {
          socket.write(payload.token);
          finish({ blocked: false, error: null });
        });
        socket.once("error", (error) => {
          const code = errorCode(error);
          finish({ blocked: code === "EPERM", error: code });
        });
      });
    }

    async function waitForFile(path, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (!existsSync(path) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return existsSync(path);
    }

    function processTokenVisible(token) {
      for (const entry of readdirSync("/proc", { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\\d+$/.test(entry.name)) continue;
        try {
          const command = readFileSync(
            join("/proc", entry.name, "cmdline"),
            "utf8",
          ).split("\\0").filter(Boolean);
          if (command.includes(token)) return true;
        } catch {
          // A process can exit during procfs enumeration.
        }
      }
      return false;
    }

    writeFileSync(payload.allowedWrite, "workspace-write-ok");
    const hostReadOnly = {
      visible: existsSync(payload.hostSentinel),
      content: existsSync(payload.hostSentinel)
        ? readFileSync(payload.hostSentinel, "utf8")
        : null,
      writeError: attemptWrite(payload.hostSentinel, "sandbox-overwrite"),
      createError: attemptWrite(payload.hostCreate, "sandbox-create"),
    };
    const launcherRoot = {
      content: readFileSync(payload.launcherSentinel, "utf8"),
      writeError: attemptWrite(payload.launcherSentinel, "sandbox-overwrite"),
      createError: attemptWrite(payload.launcherCreate, "sandbox-create"),
    };
    const network = await networkProbe();
    const survivor = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        Buffer.from(payload.descendantScript, "base64").toString("utf8"),
        payload.descendantReadyMarker,
        payload.descendantLeakMarker,
        payload.token,
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    survivor.unref();
    const descendantReady = await waitForFile(
      payload.descendantReadyMarker,
      2000,
    );
    const descendantVisible = processTokenVisible(payload.token);

    const evidence = {
      allowedWrite: true,
      appArmorProfile: readFileSync(
        "/proc/self/attr/current",
        "utf8",
      ).trim(),
      descendant: {
        ready: descendantReady,
        visibleInProc: descendantVisible,
      },
      hostReadOnly,
      launcherRoot,
      network,
      namespaces: {
        mnt: readlinkSync("/proc/self/ns/mnt"),
        net: readlinkSync("/proc/self/ns/net"),
        pid: readlinkSync("/proc/self/ns/pid"),
        user: readlinkSync("/proc/self/ns/user"),
      },
    };
    writeFileSync(payload.evidencePath, JSON.stringify(evidence));
    const passed =
      hostReadOnly.visible === true &&
      hostReadOnly.content === "host-read-only" &&
      hostReadOnly.writeError === "EROFS" &&
      hostReadOnly.createError === "EROFS" &&
      launcherRoot.content === "launcher-read-only" &&
      launcherRoot.writeError === "EROFS" &&
      launcherRoot.createError === "EROFS" &&
      evidence.appArmorProfile === payload.expectedAppArmorProfile &&
      network.blocked === true &&
      network.error === "EPERM" &&
      descendantReady === true &&
      descendantVisible === true;
    process.exit(passed ? 0 : 23);
  `;
}

function descendantProbeScript(): string {
  return `
    import { writeFileSync } from "node:fs";

    const [readyMarker, leakMarker, token] = process.argv.slice(1);
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
      process.on(signal, () => {});
    }
    writeFileSync(readyMarker, token);
    setTimeout(() => writeFileSync(leakMarker, token), 2000);
    setInterval(() => {}, 1000);
  `;
}

function effectiveCapabilities(): bigint {
  const status = readFileSync("/proc/self/status", "utf8");
  const value = /^CapEff:\s*([0-9a-f]+)$/imu.exec(status)?.[1];
  if (value === undefined) {
    throw new Error("/proc/self/status did not report CapEff");
  }
  return BigInt(`0x${value}`);
}

function stringEnvironment(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function waitForProcess(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout, timedOut });
    });
  });
}

async function terminateProcess(
  child: ChildProcessWithoutNullStreams | undefined,
): Promise<void> {
  if (
    child === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  const closed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("sandbox launcher did not terminate")),
      5_000,
    );
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  child.kill("SIGKILL");
  await closed;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function tcpRoundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("host loopback positive control timed out"));
    }, 2_000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    socket.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}

async function waitForNoProcessToken(
  token: string,
  timeoutMs: number,
): Promise<void> {
  await waitUntilNoProcessToken(token, timeoutMs);
  expect(processesContaining(token)).toEqual([]);
}

async function waitUntilNoProcessToken(
  token: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processesContaining(token).length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function killProcessesContaining(token: string): void {
  for (const match of processesContaining(token)) {
    try {
      process.kill(match.pid, "SIGKILL");
    } catch {
      // A matched descendant can exit between enumeration and signal delivery.
    }
  }
}

function processesContaining(
  token: string,
): Array<{ readonly command: string; readonly pid: number }> {
  const matches: Array<{ command: string; pid: number }> = [];
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const command = readFileSync(join("/proc", entry.name, "cmdline"), "utf8")
        .split("\0")
        .filter(Boolean)
        .join(" ");
      if (command.includes(token)) {
        matches.push({ command, pid: Number.parseInt(entry.name, 10) });
      }
    } catch {
      // Processes can exit between directory enumeration and cmdline open.
    }
  }
  return matches.sort((left, right) => left.pid - right.pid);
}
