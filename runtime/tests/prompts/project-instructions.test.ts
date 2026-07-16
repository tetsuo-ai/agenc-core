import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  AGENTS_PROJECT_INSTRUCTION_FILE,
  CLAUDE_PROJECT_INSTRUCTION_FILE,
  DEFAULT_PROJECT_DOC_MAX_BYTES,
  findProjectRoot,
  loadProjectInstructionChain,
  loadProjectInstructions,
  PRIMARY_PROJECT_INSTRUCTION_FILE,
  resolveInstructionFile,
} from "./project-instructions.js";

const POSIX = platform() !== "win32";
const posixTest = POSIX ? test : test.skip;

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

  test("resolveInstructionFile prefers AGENC.override.md over AGENC.md", async () => {
    const dir = join(root, "d");
    mkdirSync(dir);
    writeFileSync(join(dir, "AGENC.md"), "base");
    writeFileSync(join(dir, "AGENC.override.md"), "override");
    const p = await resolveInstructionFile(dir);
    expect(p?.endsWith("AGENC.override.md")).toBe(true);
  });

  test("resolveInstructionFile prefers AGENC.md over fallback files", async () => {
    const dir = join(root, "d");
    mkdirSync(dir);
    writeFileSync(join(dir, PRIMARY_PROJECT_INSTRUCTION_FILE), "primary");
    writeFileSync(join(dir, AGENTS_PROJECT_INSTRUCTION_FILE), "agents");
    writeFileSync(join(dir, CLAUDE_PROJECT_INSTRUCTION_FILE), "old");

    const p = await resolveInstructionFile(dir);

    expect(p).toBe(join(dir, PRIMARY_PROJECT_INSTRUCTION_FILE));
  });

  test("resolveInstructionFile uses AGENTS.md fallback and ignores legacy donor instructions", async () => {
    const dir = join(root, "d");
    mkdirSync(dir);
    writeFileSync(join(dir, CLAUDE_PROJECT_INSTRUCTION_FILE), "old");

    expect(await resolveInstructionFile(dir)).toBeNull();

    writeFileSync(join(dir, AGENTS_PROJECT_INSTRUCTION_FILE), "agents");

    expect(await resolveInstructionFile(dir)).toBe(
      join(dir, AGENTS_PROJECT_INSTRUCTION_FILE),
    );
  });

  test("resolveInstructionFile ignores non-AgenC instruction files", async () => {
    const dir = join(root, "d");
    mkdirSync(dir);
    writeFileSync(join(dir, "TEAM-INSTRUCTIONS.md"), "team");
    writeFileSync(join(dir, "PROJECT-INSTRUCTIONS.md"), "project");
    const p = await resolveInstructionFile(dir);
    expect(p).toBeNull();
  });

  test("resolveInstructionFile skips non-regular override files and falls back to AGENC.md", async () => {
    const dir = join(root, "d");
    mkdirSync(dir);
    mkdirSync(join(dir, "AGENC.override.md"));
    writeFileSync(join(dir, "AGENC.md"), "base");

    const p = await resolveInstructionFile(dir);

    expect(p).toBe(join(dir, "AGENC.md"));
  });

  test("loadProjectInstructions reads AGENC.md from the project root", async () => {
    const repoRoot = join(root, "proj");
    const cwd = join(repoRoot, "nested");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENC.md"), "# Project doc\n");
    const res = await loadProjectInstructions({ cwd });
    expect(res).not.toBeNull();
    expect(res!.path).toBe(join(repoRoot, "AGENC.md"));
    expect(res!.content).toBe("# Project doc\n");
    expect(res!.truncated).toBe(false);
    expect(res!.rootMarkerFound).toBe("package.json");
    expect(res!.rootDir).toBe(repoRoot);
  });

  test("loadProjectInstructions returns the closest instruction file when nested docs exist", async () => {
    const repoRoot = join(root, "proj");
    const pkgDir = join(repoRoot, "packages", "worker");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENC.md"), "ROOT");
    writeFileSync(join(pkgDir, "AGENC.md"), "PKG");

    const res = await loadProjectInstructions({ cwd: pkgDir });

    expect(res!.path).toBe(join(pkgDir, "AGENC.md"));
    expect(res!.content).toBe("PKG");
  });

  test("loadProjectInstructions keeps the closest file when an outer document exceeds the byte budget", async () => {
    const repoRoot = join(root, "proj");
    const pkgDir = join(repoRoot, "packages", "worker");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENC.md"), "ROOT-".repeat(100));
    writeFileSync(join(pkgDir, "AGENC.md"), "PKG");

    const res = await loadProjectInstructions({
      cwd: pkgDir,
      projectDocMaxBytes: 10,
    });

    expect(res!.path).toBe(join(pkgDir, "AGENC.md"));
    expect(res!.content).toBe("PKG");
    expect(res!.truncated).toBe(false);
  });

  test("loadProjectInstructions falls back to an outer document when the closest instruction is non-regular", async () => {
    const repoRoot = join(root, "proj");
    const pkgDir = join(repoRoot, "packages", "worker");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENC.md"), "ROOT");
    mkdirSync(join(pkgDir, "AGENC.md"));

    const res = await loadProjectInstructions({ cwd: pkgDir });

    expect(res!.path).toBe(join(repoRoot, "AGENC.md"));
    expect(res!.content).toBe("ROOT");
  });

  posixTest(
    "loadProjectInstructions falls back to an outer document when the closest instruction cannot be read",
    async () => {
      const repoRoot = join(root, "proj");
      const pkgDir = join(repoRoot, "packages", "worker");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(repoRoot, "package.json"), "{}");
      writeFileSync(join(repoRoot, "AGENC.md"), "ROOT");
      symlinkSync(join(pkgDir, "missing.md"), join(pkgDir, "AGENC.md"));

      const res = await loadProjectInstructions({ cwd: pkgDir });

      expect(res!.path).toBe(join(repoRoot, "AGENC.md"));
      expect(res!.content).toBe("ROOT");
    },
  );

  test.runIf(process.platform !== "win32")(
    "rejects an instruction entrypoint symlink that escapes the workspace",
    async () => {
      const repoRoot = join(root, "proj");
      const outside = join(root, "outside.md");
      mkdirSync(repoRoot, { recursive: true });
      writeFileSync(join(repoRoot, "package.json"), "{}");
      writeFileSync(outside, "EXTERNAL_SECRET");
      symlinkSync(outside, join(repoRoot, "AGENC.md"));

      const result = await loadProjectInstructions({ cwd: repoRoot });
      expect(result).toBeNull();
    },
  );

  test("loadProjectInstructions prefers AGENC.override.md", async () => {
    const repoRoot = join(root, "proj");
    mkdirSync(repoRoot);
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENC.md"), "base");
    writeFileSync(join(repoRoot, "AGENC.override.md"), "override");
    const res = await loadProjectInstructions({ cwd: repoRoot });
    expect(res!.path.endsWith("AGENC.override.md")).toBe(true);
    expect(res!.content).toBe("override");
  });

  test("loadProjectInstructions truncates at projectDocMaxBytes", async () => {
    const repoRoot = join(root, "proj");
    mkdirSync(repoRoot);
    writeFileSync(join(repoRoot, "package.json"), "{}");
    const big = "x".repeat(1000);
    writeFileSync(join(repoRoot, "AGENC.md"), big);
    const res = await loadProjectInstructions({
      cwd: repoRoot,
      projectDocMaxBytes: 100,
    });
    expect(res!.truncated).toBe(true);
    // 100 bytes kept + marker appended.
    expect(res!.content.startsWith("x".repeat(100))).toBe(true);
    expect(res!.content).toContain("truncated by project_doc_max_bytes");
  });

  test("loadProjectInstructions and loadProjectInstructionChain truncate at a UTF-8 code point boundary", async () => {
    const repoRoot = join(root, "proj");
    const leafDir = join(repoRoot, "nested");
    mkdirSync(leafDir, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENC.md"), "A🙂B");
    writeFileSync(join(leafDir, "AGENC.md"), "C🙂D");

    const singular = await loadProjectInstructions({
      cwd: repoRoot,
      projectDocMaxBytes: 3,
    });
    expect(singular!.truncated).toBe(true);
    expect(singular!.content).toBe(
      "A\n\n<!-- [truncated by project_doc_max_bytes] -->\n",
    );
    expect(singular!.content).not.toContain("\uFFFD");

    const chain = await loadProjectInstructionChain({
      cwd: leafDir,
      projectDocMaxBytes: 3,
    });
    expect(chain).toHaveLength(1);
    expect(chain[0]!.truncated).toBe(true);
    expect(chain[0]!.content).toBe(
      "A\n\n<!-- [truncated by project_doc_max_bytes] -->\n",
    );
    expect(chain[0]!.content).not.toContain("\uFFFD");
  });

  test("loadProjectInstructions falls back to cwd when no marker is found", async () => {
    const cwd = join(root, "no-markers");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "AGENC.md"), "cwd-doc");
    const res = await loadProjectInstructions({
      cwd,
      // Use a marker that doesn't exist anywhere from `cwd` up to `/`.
      projectRootMarkers: ["nonexistent-marker-abc-xyz-123"],
    });
    expect(res).not.toBeNull();
    expect(res!.path).toBe(join(cwd, "AGENC.md"));
    expect(res!.content).toBe("cwd-doc");
    expect(res!.rootMarkerFound).toBe("<cwd>");
    expect(res!.rootDir).toBe(cwd);
  });

  test("loadProjectInstructions respects zero byte budget", async () => {
    const repoRoot = join(root, "proj");
    mkdirSync(repoRoot);
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENC.md"), "hi");
    const res = await loadProjectInstructions({
      cwd: repoRoot,
      projectDocMaxBytes: 0,
    });
    expect(res).toBeNull();
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 5 * 1024 * 1024 + 1])(
    "loadProjectInstructions rejects unsafe byte budget %s",
    async (projectDocMaxBytes) => {
      await expect(
        loadProjectInstructions({ cwd: root, projectDocMaxBytes }),
      ).rejects.toThrow(RangeError);
      await expect(
        loadProjectInstructionChain({ cwd: root, projectDocMaxBytes }),
      ).rejects.toThrow(RangeError);
    },
  );

  test("loadProjectInstructions uses default budget when unspecified", async () => {
    const repoRoot = join(root, "proj");
    mkdirSync(repoRoot);
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENC.md"), "small");
    const res = await loadProjectInstructions({ cwd: repoRoot });
    expect(res!.truncated).toBe(false);
    expect(res!.content).toBe("small");
    expect(DEFAULT_PROJECT_DOC_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  test("loadProjectInstructions returns null when marker found but no instruction file", async () => {
    const repoRoot = join(root, "proj");
    mkdirSync(repoRoot);
    writeFileSync(join(repoRoot, "package.json"), "{}");
    // No AGENC.md instruction file present.
    const res = await loadProjectInstructions({ cwd: repoRoot });
    expect(res).toBeNull();
  });

  test("loadProjectInstructionChain collects root-to-cwd docs in order", async () => {
    const repoRoot = join(root, "proj");
    const pkgDir = join(repoRoot, "packages", "worker");
    const leafDir = join(pkgDir, "src");
    mkdirSync(leafDir, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENC.md"), "ROOT");
    writeFileSync(join(pkgDir, "AGENC.md"), "PKG");
    writeFileSync(join(leafDir, "AGENC.override.md"), "LEAF");

    const chain = await loadProjectInstructionChain({ cwd: leafDir });
    expect(chain.map((entry) => entry.path)).toEqual([
      join(repoRoot, "AGENC.md"),
      join(pkgDir, "AGENC.md"),
      join(leafDir, "AGENC.override.md"),
    ]);
    expect(chain.map((entry) => entry.content)).toEqual(["ROOT", "PKG", "LEAF"]);
  });

  test("loadProjectInstructionChain applies the byte budget across the full chain", async () => {
    const repoRoot = join(root, "proj");
    const leafDir = join(repoRoot, "nested");
    mkdirSync(leafDir, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENC.md"), "ROOT-CONTENT");
    writeFileSync(join(leafDir, "AGENC.md"), "LEAF-CONTENT");

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
    writeFileSync(join(repoRoot, "AGENC.md"), "ROOT");
    writeFileSync(join(leafDir, "AGENC.md"), "LEAF");

    const chain = await loadProjectInstructionChain({
      cwd: leafDir,
      projectRootMarkers: [],
    });
    expect(chain).toHaveLength(1);
    expect(chain[0]!.path).toBe(join(leafDir, "AGENC.md"));
    expect(chain[0]!.content).toBe("LEAF");
    expect(chain[0]!.rootMarkerFound).toBe("<cwd>");
    expect(chain[0]!.rootDir).toBe(leafDir);
  });
});
