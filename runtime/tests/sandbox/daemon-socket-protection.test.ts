import "../helpers/cron-os-home.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agenCDaemonLocalEndpoint } from "../../../packages/agenc-sdk/lib/local-endpoint.mjs";
import { canWritePathWithCwd } from "../../src/sandbox/engine/index.js";
import { effectivePermissionProfile } from "../../src/sandbox/engine/policy-transforms.js";
import { createSeatbeltCommandArgs } from "../../src/sandbox/engine/seatbelt.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { createBwrapCommandArgs } from "../../src/sandbox/linux-launcher/bwrap.js";
import { enforceRuntimeSandboxAttempt, permissionProfileForRuntimeContext } from "../../src/tools/runtimes/sandboxing.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "agenc-socket-policy-")));
  roots.push(workspace);
  const home = join(workspace, "long-home-".repeat(15));
  mkdirSync(home);
  const socket = agenCDaemonLocalEndpoint(home);
  const authority = realpathSync(dirname(socket));
  const temp = join(workspace, "tmp");
  mkdirSync(temp);
  const alias = join(workspace, "socket-alias");
  symlinkSync(authority, alias, "dir");
  const context = {
    sandboxMode: "workspace_write", approvalResolved: true,
    additionalPermissions: { fileSystem: { entries: [
      { path: { kind: "special", value: { kind: "root" } }, access: "write" },
      { path: { kind: "path", path: socket }, access: "write" },
    ] } },
    invocation: { turn: { cwd: workspace }, session: { services: {
      configStore: { homeContext: { path: home } },
      runtimeOptions: { sessionTempRoot: temp },
    } } },
  } as never;
  return { workspace, home, socket, authority, temp, alias, context };
}

describe.skipIf(process.platform === "win32")("daemon fallback socket reservation", () => {
  it("denies writes, aliases, removal and ancestor replacement despite explicit grants", () => {
    const f = fixture();
    const profile = permissionProfileForRuntimeContext(f.context, { cwd: f.workspace });
    expect(profile.fileSystem.reservedReadOnlyPaths).toContain(f.authority);
    for (const target of [f.socket, f.authority, join(f.alias, "replacement.sock")]) {
      expect(canWritePathWithCwd(profile.fileSystem, target, f.workspace, f.temp)).toBe(false);
    }
    for (const target of [f.socket, f.authority, f.alias, dirname(f.authority), "/tmp"]) {
      expect(() => enforceRuntimeSandboxAttempt({ context: f.context,
        tool: { name: "Write", metadata: { mutating: true } } as never,
        args: { file_path: target },
      })).toThrow(/Daemon sockets are reserved for the native host/);
    }
    expect(canWritePathWithCwd(profile.fileSystem, join(f.temp, "ordinary.txt"), f.workspace, f.temp)).toBe(true);
  });

  it("keeps the reservation in broker forks and additional permission transforms", () => {
    const f = fixture();
    const broker = new SandboxExecutionBroker({ mode: "workspace_write", cwd: f.workspace,
      env: { ...process.env, AGENC_HOME: f.home }, sessionTempRoot: f.temp,
      probe: () => ({ kind: "ready", mode: "workspace_write", platform: process.platform }),
    });
    for (const active of [broker, broker.forkForCwd(f.authority)]) {
      const profile = effectivePermissionProfile(active.runtimeSandbox("tool")!.permissionProfile, {
        fileSystem: { entries: [{ path: { kind: "path", path: f.socket }, access: "write" }] },
      });
      expect(profile.fileSystem.reservedReadOnlyPaths).toContain(f.authority);
      expect(canWritePathWithCwd(profile.fileSystem, f.socket, active.cwd, f.temp)).toBe(false);
    }
  });

  it("projects hard write and ancestor-removal protection into macOS and Linux sandboxes", () => {
    const f = fixture();
    const profile = permissionProfileForRuntimeContext(f.context, { cwd: f.workspace });
    const index = profile.fileSystem.reservedReadOnlyPaths!.indexOf(f.authority);
    const seatbelt = createSeatbeltCommandArgs({ command: ["/bin/true"],
      fileSystemSandboxPolicy: profile.fileSystem, networkSandboxPolicy: "disabled",
      sandboxPolicyCwd: f.workspace, sessionTempRoot: f.temp, enforceManagedNetwork: false });
    expect(seatbelt).toContain(`-DRESERVED_READ_ONLY_${index}=${f.authority}`);
    expect(seatbelt[1]).toContain(`(deny file-write* (subpath (param "RESERVED_READ_ONLY_${index}")))`);
    const ancestor = seatbelt.find(arg => /^-DRESERVED_ANCESTOR_\d+=/.test(arg) && arg.endsWith(`=${dirname(f.authority)}`))!;
    expect(ancestor).toBeDefined();
    expect(seatbelt[1]).toContain(`(deny file-write-unlink (literal (param "${ancestor.slice(2).split("=")[0]}")))`);
    const bwrap = createBwrapCommandArgs(["/bin/true"], profile.fileSystem, f.workspace, f.workspace,
      { mountProc: false, networkMode: "isolated", sessionTempRoot: f.temp });
    expect(bwrap.args.join("\n")).toContain(`--ro-bind\n${f.authority}\n${f.authority}`);
    expect(bwrap.args.join("\n")).toContain(`--bind\n${dirname(f.authority)}\n${dirname(f.authority)}`);
  });
});
