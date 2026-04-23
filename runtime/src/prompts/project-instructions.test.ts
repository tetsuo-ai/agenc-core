import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  DEFAULT_PROJECT_DOC_MAX_BYTES,
  findProjectRoot,
  loadProjectInstructionChain,
  loadProjectInstructions,
  resolveInstructionFile,
} from "./project-instructions.js";

describe("project-instructions (T10-B)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agenc-proj-inst-"));
  });
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  test("findProjectRoot locates nearest `.git` marker via ancestor walk", async () => {
    const repoRoot = join(root, "repo");
    const nested = join(repoRoot, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repoRoot, ".git"));
    const r = await findProjectRoot(nested);
    expect(r?.marker).toBe(".git");
    expect(r?.rootDir).toBe(repoRoot);
  });

  test("findProjectRoot locates `package.json` marker", async () => {
    const repoRoot = join(root, "pkg");
    const nested = join(repoRoot, "src", "deep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    const r = await findProjectRoot(nested);
    expect(r?.marker).toBe("package.json");
    expect(r?.rootDir).toBe(repoRoot);
  });

  test("findProjectRoot returns null when no marker found", async () => {
    const empty = join(root, "no-markers");
    mkdirSync(empty, { recursive: true });
    // Only walk into the isolated root so parent (`tmp`) has nothing.
    // Can't fully sandbox to `/` but absence inside `empty` is the bit
    // we care about.
    const r = await findProjectRoot(empty, ["nonexistent-marker-xyzzy"]);
    expect(r).toBeNull();
  });

  test("resolveInstructionFile prefers AGENTS.override.md over AGENTS.md", async () => {
    const dir = join(root, "d");
    mkdirSync(dir);
    writeFileSync(join(dir, "AGENTS.md"), "base");
    writeFileSync(join(dir, "AGENTS.override.md"), "override");
    const p = await resolveInstructionFile(dir);
    expect(p?.endsWith("AGENTS.override.md")).toBe(true);
  });

  test("resolveInstructionFile falls back to CLAUDE.md when only CLAUDE.md exists", async () => {
    const dir = join(root, "d");
    mkdirSync(dir);
    writeFileSync(join(dir, "CLAUDE.md"), "legacy");
    const p = await resolveInstructionFile(dir);
    expect(p?.endsWith("CLAUDE.md")).toBe(true);
  });

  test("loadProjectInstructions reads AGENTS.md from the project root", async () => {
    const repoRoot = join(root, "proj");
    const cwd = join(repoRoot, "nested");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENTS.md"), "# Project doc\n");
    const res = await loadProjectInstructions({ cwd });
    expect(res).not.toBeNull();
    expect(res!.path).toBe(join(repoRoot, "AGENTS.md"));
    expect(res!.content).toBe("# Project doc\n");
    expect(res!.truncated).toBe(false);
    expect(res!.rootMarkerFound).toBe("package.json");
    expect(res!.rootDir).toBe(repoRoot);
  });

  test("loadProjectInstructions prefers AGENTS.override.md", async () => {
    const repoRoot = join(root, "proj");
    mkdirSync(repoRoot);
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENTS.md"), "base");
    writeFileSync(join(repoRoot, "AGENTS.override.md"), "override");
    const res = await loadProjectInstructions({ cwd: repoRoot });
    expect(res!.path.endsWith("AGENTS.override.md")).toBe(true);
    expect(res!.content).toBe("override");
  });

  test("loadProjectInstructions truncates at projectDocMaxBytes", async () => {
    const repoRoot = join(root, "proj");
    mkdirSync(repoRoot);
    writeFileSync(join(repoRoot, "package.json"), "{}");
    const big = "x".repeat(1000);
    writeFileSync(join(repoRoot, "AGENTS.md"), big);
    const res = await loadProjectInstructions({
      cwd: repoRoot,
      projectDocMaxBytes: 100,
    });
    expect(res!.truncated).toBe(true);
    // 100 bytes kept + marker appended.
    expect(res!.content.startsWith("x".repeat(100))).toBe(true);
    expect(res!.content).toContain("truncated by project_doc_max_bytes");
  });

  test("loadProjectInstructions falls back to cwd when no marker is found", async () => {
    const cwd = join(root, "no-markers");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "AGENTS.md"), "cwd-doc");
    const res = await loadProjectInstructions({
      cwd,
      // Use a marker that doesn't exist anywhere from `cwd` up to `/`.
      projectRootMarkers: ["nonexistent-marker-abc-xyz-123"],
    });
    expect(res).not.toBeNull();
    expect(res!.path).toBe(join(cwd, "AGENTS.md"));
    expect(res!.content).toBe("cwd-doc");
    expect(res!.rootMarkerFound).toBe("<cwd>");
    expect(res!.rootDir).toBe(cwd);
  });

  test("loadProjectInstructions respects zero byte budget", async () => {
    const repoRoot = join(root, "proj");
    mkdirSync(repoRoot);
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENTS.md"), "hi");
    const res = await loadProjectInstructions({
      cwd: repoRoot,
      projectDocMaxBytes: 0,
    });
    expect(res).toBeNull();
  });

  test("loadProjectInstructions uses default budget when unspecified", async () => {
    const repoRoot = join(root, "proj");
    mkdirSync(repoRoot);
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENTS.md"), "small");
    const res = await loadProjectInstructions({ cwd: repoRoot });
    expect(res!.truncated).toBe(false);
    expect(res!.content).toBe("small");
    expect(DEFAULT_PROJECT_DOC_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  test("loadProjectInstructions returns null when marker found but no AGENTS.md", async () => {
    const repoRoot = join(root, "proj");
    mkdirSync(repoRoot);
    writeFileSync(join(repoRoot, "package.json"), "{}");
    // No AGENTS.md / CLAUDE.md present.
    const res = await loadProjectInstructions({ cwd: repoRoot });
    expect(res).toBeNull();
  });

  test("loadProjectInstructionChain collects root-to-cwd docs in order", async () => {
    const repoRoot = join(root, "proj");
    const pkgDir = join(repoRoot, "packages", "worker");
    const leafDir = join(pkgDir, "src");
    mkdirSync(leafDir, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENTS.md"), "ROOT");
    writeFileSync(join(pkgDir, "CLAUDE.md"), "PKG");
    writeFileSync(join(leafDir, "AGENTS.override.md"), "LEAF");

    const chain = await loadProjectInstructionChain({ cwd: leafDir });
    expect(chain.map((entry) => entry.path)).toEqual([
      join(repoRoot, "AGENTS.md"),
      join(pkgDir, "CLAUDE.md"),
      join(leafDir, "AGENTS.override.md"),
    ]);
    expect(chain.map((entry) => entry.content)).toEqual(["ROOT", "PKG", "LEAF"]);
  });

  test("loadProjectInstructionChain applies the byte budget across the full chain", async () => {
    const repoRoot = join(root, "proj");
    const leafDir = join(repoRoot, "nested");
    mkdirSync(leafDir, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENTS.md"), "ROOT-CONTENT");
    writeFileSync(join(leafDir, "AGENTS.md"), "LEAF-CONTENT");

    const chain = await loadProjectInstructionChain({
      cwd: leafDir,
      projectDocMaxBytes: 14,
    });
    expect(chain).toHaveLength(2);
    expect(chain[0]!.content).toBe("ROOT-CONTENT");
    expect(chain[0]!.truncated).toBe(false);
    expect(chain[1]!.truncated).toBe(true);
    expect(chain[1]!.content).toContain("truncated by project_doc_max_bytes");
  });

  test("loadProjectInstructionChain treats an explicit empty marker list as cwd-only discovery", async () => {
    const repoRoot = join(root, "proj");
    const leafDir = join(repoRoot, "nested");
    mkdirSync(leafDir, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENTS.md"), "ROOT");
    writeFileSync(join(leafDir, "AGENTS.md"), "LEAF");

    const chain = await loadProjectInstructionChain({
      cwd: leafDir,
      projectRootMarkers: [],
    });
    expect(chain).toHaveLength(1);
    expect(chain[0]!.path).toBe(join(leafDir, "AGENTS.md"));
    expect(chain[0]!.content).toBe("LEAF");
    expect(chain[0]!.rootMarkerFound).toBe("<cwd>");
    expect(chain[0]!.rootDir).toBe(leafDir);
  });
});
