import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  restrictedFileSystemPolicy,
  unrestrictedFileSystemPolicy,
} from "../../../src/sandbox/engine/policy.js";
import {
  agencHomeCarveOutAllowsWrite,
  permissionProfileForSandboxMode,
} from "../../../src/tools/runtimes/sandboxing.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-home-carve-out-")));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const memory = join(home, "memory", "note.md");
  mkdirSync(cwd);
  mkdirSync(join(home, "memory"), { recursive: true });
  return { root, home, cwd, memory, temp: join(cwd, "tmp") };
}

describe("agencHomeCarveOutAllowsWrite", () => {
  it("admits a restricted workspace_write policy by treating the root read as write", () => {
    const f = fixture();
    const policy = permissionProfileForSandboxMode("workspace_write", { cwd: f.cwd }).fileSystem;
    expect(agencHomeCarveOutAllowsWrite(policy, f.memory, f.cwd, f.temp)).toBe(true);
    expect(agencHomeCarveOutAllowsWrite(policy, join(f.home, "config.toml"), f.cwd, f.temp)).toBe(true);
  });

  it("still honors a more specific deny and a reserved home", () => {
    const f = fixture();
    const denied = restrictedFileSystemPolicy([
      { path: { kind: "special", value: { kind: "root" } }, access: "read" },
      { path: { kind: "path", path: join(f.home, "memory") }, access: "read" },
    ]);
    expect(agencHomeCarveOutAllowsWrite(denied, f.memory, f.cwd, f.temp)).toBe(false);
    const reserved = restrictedFileSystemPolicy(
      [{ path: { kind: "special", value: { kind: "root" } }, access: "read" }],
      { reservedReadOnlyPaths: [f.home] },
    );
    expect(agencHomeCarveOutAllowsWrite(reserved, f.memory, f.cwd, f.temp)).toBe(false);
  });

  it("never opens an unrestricted or external policy through the carve-out", () => {
    const f = fixture();
    expect(agencHomeCarveOutAllowsWrite(unrestrictedFileSystemPolicy(), f.memory, f.cwd, f.temp))
      .toBe(false);
    expect(agencHomeCarveOutAllowsWrite(
      { kind: "external_sandbox", entries: [] }, f.memory, f.cwd, f.temp,
    )).toBe(false);
  });
});
