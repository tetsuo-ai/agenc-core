import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { protectAgencHomeUnderWritableRoot } from "../../src/sandbox/agenc-home-protection.js";
import { canWritePathWithCwd } from "../../src/sandbox/engine/index.js";
import { effectivePermissionProfile } from "../../src/sandbox/engine/policy-transforms.js";
import { createBwrapCommandArgs } from "../../src/sandbox/linux-launcher/bwrap.js";
import { planLandlockConfinement } from "../../src/sandbox/linux-launcher/landlock-exec.js";
import { permissionProfileForSandboxMode, pluginMcpPermissionProfile } from "../../src/tools/runtimes/sandboxing.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-home-protection-")));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  for (const dir of [home, cwd]) mkdirSync(dir);
  writeFileSync(join(home, "config.toml"), "config_version = 2\n");
  return { root, home, cwd };
}

describe("AgenC home beneath writable roots", () => {
  it.each(["temp", "workspace"])("reserves home beneath a writable %s despite nested grants and aliases", (kind) => {
    const f = fixture();
    const cwd = kind === "workspace" ? f.root : f.cwd;
    const temp = kind === "temp" ? f.root : join(f.root, "isolated-tmp");
    mkdirSync(temp, { recursive: true });
    const original = permissionProfileForSandboxMode("workspace_write", { cwd });
    const profile = protectAgencHomeUnderWritableRoot(original, f.home, cwd, temp);
    const granted = effectivePermissionProfile(profile, { fileSystem: { entries: [
      { path: { kind: "path", path: join(f.home, "config.toml") }, access: "write" },
    ] } });
    const alias = join(f.root, "home-alias");
    symlinkSync(f.home, alias);
    for (const target of [join(f.home, "config.toml"), join(alias, "config.toml")]) {
      expect(canWritePathWithCwd(granted.fileSystem, target, cwd, temp)).toBe(false);
    }
    expect(canWritePathWithCwd(granted.fileSystem, join(cwd, "ordinary.txt"), cwd, temp)).toBe(true);
    const command = createBwrapCommandArgs(["/bin/true"], granted.fileSystem, cwd, cwd,
      { mountProc: false, networkMode: "isolated", sessionTempRoot: temp });
    const args = command.args.join("\n");
    const writable = `--bind\n${kind === "temp" ? temp : cwd}\n`;
    const readonly = `--ro-bind\n${f.home}\n${f.home}`;
    expect(args).toContain(writable);
    expect(args).toContain(readonly);
    expect(args.indexOf(readonly)).toBeGreaterThan(args.indexOf(writable));
    expect(planLandlockConfinement({ fileSystem: granted.fileSystem, sandboxPolicyCwd: cwd,
      sessionTempRoot: temp, allowNetworkForProxy: false, inheritedCwd: false }).kind).toBe("refused");
  });

  it("preserves a validated plugin data grant that does not contain home", () => {
    const f = fixture();
    const data = join(f.home, "plugins", "data");
    mkdirSync(data, { recursive: true });
    const profile = protectAgencHomeUnderWritableRoot(pluginMcpPermissionProfile({ pluginDataDir: data }),
      f.home, f.cwd, join(data, "tmp"));
    expect(canWritePathWithCwd(profile.fileSystem, join(data, "state.json"), f.cwd, data)).toBe(true);
    expect(canWritePathWithCwd(profile.fileSystem, join(f.home, "config.toml"), f.cwd, data)).toBe(false);
  });
});
