import { chmodSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const readDirHook = vi.hoisted(() => ({ run: null as ((path: string) => void) | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readdir: (...args: unknown[]) => {
      if (typeof args[0] === "string") readDirHook.run?.(args[0]);
      return Reflect.apply(original.readdir, original, args);
    },
  };
});

import { createLocalSkillsServices, loadLocalSkillsSnapshot } from "./local-loader.js";

function tmpRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `agenc-${label}-`));
}

function writeSkill(dir: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\ndescription: ${description}\n---\n${description} body\n`);
}

function fixture() {
  const workspaceRoot = tmpRoot("link-swap-workspace");
  const root = join(workspaceRoot, ".agents", "skills");
  const safeDir = join(tmpRoot("link-swap-safe"), "linked");
  const unsafeParent = tmpRoot("link-swap-unsafe");
  const unsafeDir = join(unsafeParent, "linked");
  const bridgeParent = tmpRoot("link-swap-bridge");
  const bridge = join(bridgeParent, "bridge");
  const link = join(root, "linked");
  writeSkill(safeDir, "safe");
  writeSkill(unsafeDir, "unsafe");
  chmodSync(unsafeParent, 0o777);
  chmodSync(bridgeParent, 0o777);
  mkdirSync(root, { recursive: true });
  symlinkSync(safeDir, bridge);
  symlinkSync(bridge, link);
  const agencHome = tmpRoot("link-swap-home");
  const options = {
    agencHome,
    pluginStorageRoot: join(agencHome, "plugins"),
    workspaceRoot,
    env: { HOME: tmpRoot("link-swap-user") },
  };
  return { options, root, link, bridge, safeDir, unsafeDir };
}

function retarget(link: string, target: string): void {
  const replacement = `${link}-replacement`;
  symlinkSync(target, replacement);
  renameSync(replacement, link);
}

afterEach(() => {
  readDirHook.run = null;
});

describe("project skill real-path reads", () => {
  it("keeps scanning and loading the validated target after an intermediate link is swapped", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    let swapped = false;
    readDirHook.run = (path) => {
      if (swapped || (path !== f.link && path !== f.safeDir)) return;
      retarget(f.bridge, f.unsafeDir);
      swapped = true;
    };

    const snapshot = await loadLocalSkillsSnapshot(f.options);
    expect(swapped).toBe(true);
    const skill = snapshot.skills.find((entry) => entry.path === join(f.link, "SKILL.md"));
    expect(skill?.description).toBe("safe");
    expect(skill?.path).toBe(join(f.link, "SKILL.md"));
    expect(skill?.root).toBe(f.root);
  });

  it("reads the recorded target on invocation after the bridge is swapped", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const services = createLocalSkillsServices(f.options);
    const skill = await services.skillsManager.resolveSkill("linked");
    expect(skill?.description).toBe("safe");
    retarget(f.bridge, f.unsafeDir);

    const rendered = await services.skillsManager.renderSkill({ name: "linked" });
    expect(rendered?.content).toContain("safe body");
    expect(rendered?.content).not.toContain("unsafe body");
    expect(rendered?.content).toContain(`Base directory for this skill: ${f.link}`);
  });

  it("refuses invocation when the recorded real path resolves to an unsafe target", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const services = createLocalSkillsServices(f.options);
    expect((await services.skillsManager.resolveSkill("linked"))?.description).toBe("safe");
    renameSync(f.safeDir, `${f.safeDir}-old`);
    symlinkSync(f.unsafeDir, f.safeDir);

    await expect(services.skillsManager.renderSkill({ name: "linked" }))
      .rejects.toThrow(/project skill.*safe location/i);
  });
});
