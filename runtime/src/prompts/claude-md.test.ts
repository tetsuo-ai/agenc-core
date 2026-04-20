import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  assembleTieredInstructions,
  isPathWithin,
  loadTieredInstructions,
  resolveIncludes,
  type TierEntry,
  type TieredInstructions,
} from "./claude-md.js";

describe("claude-md (T10-B tiered + @include)", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agenc-claude-md-"));
  });
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  });

  // ---- 4-tier precedence ----

  test("loadTieredInstructions loads all four tiers when present", async () => {
    const home = join(tmp, "home");
    const managedDir = join(tmp, "etc-managed");
    const repoRoot = join(tmp, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(managedDir, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(join(home, ".agenc"));
    writeFileSync(join(managedDir, "managed.md"), "MANAGED");
    writeFileSync(join(home, ".agenc", "AGENTS.md"), "USER");
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENTS.md"), "PROJECT");
    writeFileSync(join(repoRoot, "AGENTS.local.md"), "LOCAL");

    const tiers = await loadTieredInstructions({
      cwd: repoRoot,
      homeDir: home,
      managedPath: join(managedDir, "managed.md"),
    });
    expect(tiers.managed?.content).toBe("MANAGED");
    expect(tiers.user?.content).toBe("USER");
    expect(tiers.project?.content).toBe("PROJECT");
    expect(tiers.local?.content).toBe("LOCAL");
  });

  test("loadTieredInstructions returns null for missing tiers", async () => {
    const home = join(tmp, "home");
    const repoRoot = join(tmp, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENTS.md"), "project only");

    const tiers = await loadTieredInstructions({
      cwd: repoRoot,
      homeDir: home,
      managedPath: join(tmp, "nope", "missing.md"),
    });
    expect(tiers.managed).toBeNull();
    expect(tiers.user).toBeNull();
    expect(tiers.project?.content).toBe("project only");
    expect(tiers.local).toBeNull();
  });

  test("loadTieredInstructions falls back to ~/.claude/CLAUDE.md when ~/.agenc/AGENTS.md absent", async () => {
    const home = join(tmp, "home");
    const repoRoot = join(tmp, "repo");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "CLAUDE-COMPAT");
    writeFileSync(join(repoRoot, "package.json"), "{}");

    const tiers = await loadTieredInstructions({
      cwd: repoRoot,
      homeDir: home,
      managedPath: join(tmp, "none"),
    });
    expect(tiers.user?.content).toBe("CLAUDE-COMPAT");
  });

  // ---- assembly ----

  test("assembleTieredInstructions emits tier separator headers in order", () => {
    const mk = (tier: TierEntry["tier"], path: string, content: string): TierEntry => ({
      tier,
      path,
      content,
      rawContent: content,
      dropped: [],
    });
    const tiers: TieredInstructions = {
      managed: mk("managed", "/etc/agenc/AGENTS.md", "M"),
      user: mk("user", "/home/u/.agenc/AGENTS.md", "U"),
      project: mk("project", "/r/AGENTS.md", "P"),
      local: mk("local", "/r/AGENTS.local.md", "L"),
    };
    const text = assembleTieredInstructions(tiers);
    // Each tier header includes the path.
    expect(text).toContain("--- managed (/etc/agenc/AGENTS.md) ---");
    expect(text).toContain("--- user (/home/u/.agenc/AGENTS.md) ---");
    expect(text).toContain("--- project (/r/AGENTS.md) ---");
    expect(text).toContain("--- local (/r/AGENTS.local.md) ---");
    // Order: managed then user then project then local.
    const mi = text.indexOf("managed");
    const ui = text.indexOf("user");
    const pi = text.indexOf("project");
    const li = text.indexOf("local");
    expect(mi).toBeLessThan(ui);
    expect(ui).toBeLessThan(pi);
    expect(pi).toBeLessThan(li);
  });

  test("assembleTieredInstructions skips missing tiers silently", () => {
    const tiers: TieredInstructions = {
      managed: null,
      user: null,
      project: {
        tier: "project",
        path: "/r/AGENTS.md",
        content: "only me",
        rawContent: "only me",
        dropped: [],
      },
      local: null,
    };
    const text = assembleTieredInstructions(tiers);
    expect(text).toContain("--- project (/r/AGENTS.md) ---");
    expect(text).toContain("only me");
    expect(text).not.toContain("--- managed");
  });

  // ---- @include directive ----

  test("@include happy path one level", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "child.md"), "CHILD CONTENT");
    const res = await resolveIncludes("intro\n@include child.md\noutro", {
      baseDir: repo,
      projectRoot: repo,
    });
    expect(res.text).toContain("intro");
    expect(res.text).toContain("<!-- @include child.md -->");
    expect(res.text).toContain("CHILD CONTENT");
    expect(res.text).toContain("outro");
    expect(res.included).toEqual([join(repo, "child.md")]);
    expect(res.dropped).toHaveLength(0);
  });

  test("@include nested two levels", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "a.md"), "A\n@include b.md");
    writeFileSync(join(repo, "b.md"), "B CONTENT");
    const res = await resolveIncludes("@include a.md", {
      baseDir: repo,
      projectRoot: repo,
    });
    expect(res.text).toContain("A");
    expect(res.text).toContain("B CONTENT");
    expect(res.included).toHaveLength(2);
    expect(res.dropped).toHaveLength(0);
  });

  test("I-75: @include escaping project root is rejected with warning", async () => {
    const repo = join(tmp, "repo");
    const outside = join(tmp, "outside");
    mkdirSync(repo);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.md"), "SECRET");
    const res = await resolveIncludes("@include ../outside/secret.md", {
      baseDir: repo,
      projectRoot: repo,
    });
    expect(res.included).toHaveLength(0);
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0]!.reason).toBe("path_escape");
    expect(res.text).not.toContain("SECRET");
    // Marker still left.
    expect(res.text).toContain("<!-- @include ../outside/secret.md -->");
  });

  test("I-75: absolute /etc/passwd-style @include rejected", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const res = await resolveIncludes("@include /etc/passwd", {
      baseDir: repo,
      projectRoot: repo,
    });
    expect(res.dropped[0]!.reason).toBe("path_escape");
  });

  test("@include circular A->B->A rejected", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "a.md"), "A\n@include b.md");
    writeFileSync(join(repo, "b.md"), "B\n@include a.md");
    const res = await resolveIncludes("@include a.md", {
      baseDir: repo,
      projectRoot: repo,
    });
    // A included once, then B included once, then A re-entry dropped.
    const cyc = res.dropped.find((d) => d.reason === "circular");
    expect(cyc).toBeDefined();
    expect(cyc!.requestedPath).toBe("a.md");
  });

  test("@include max-depth exceeded", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    // Chain of N files each pointing to the next.
    const N = 5;
    for (let i = 0; i < N; i++) {
      const next = i + 1 < N ? `@include f${i + 1}.md` : "LEAF";
      writeFileSync(join(repo, `f${i}.md`), next);
    }
    const res = await resolveIncludes("@include f0.md", {
      baseDir: repo,
      projectRoot: repo,
      maxDepth: 2,
    });
    const dd = res.dropped.find((d) => d.reason === "max_depth");
    expect(dd).toBeDefined();
  });

  test("@include max-bytes exceeded", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "big.md"), "x".repeat(1000));
    const res = await resolveIncludes("@include big.md", {
      baseDir: repo,
      projectRoot: repo,
      maxBytes: 500,
    });
    expect(res.dropped[0]!.reason).toBe("max_bytes");
    expect(res.text).toContain("<!-- @include big.md -->");
    expect(res.text).not.toContain("x".repeat(1000));
  });

  test("multiple @include in one file", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "one.md"), "ONE");
    writeFileSync(join(repo, "two.md"), "TWO");
    writeFileSync(join(repo, "three.md"), "THREE");
    const res = await resolveIncludes(
      "pre\n@include one.md\nmid\n@include two.md\n@include three.md\npost",
      { baseDir: repo, projectRoot: repo },
    );
    expect(res.text).toContain("ONE");
    expect(res.text).toContain("TWO");
    expect(res.text).toContain("THREE");
    expect(res.included).toHaveLength(3);
  });

  test("@include with missing target warns and skips", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const res = await resolveIncludes("@include nope.md", {
      baseDir: repo,
      projectRoot: repo,
    });
    expect(res.dropped[0]!.reason).toBe("not_found");
    expect(res.text).toContain("<!-- @include nope.md -->");
  });

  test("isPathWithin boundary check rejects `..` escapes and absolute escapes", () => {
    expect(isPathWithin("/root/x/y", "/root/x")).toBe(true);
    expect(isPathWithin("/root/x", "/root/x")).toBe(true);
    expect(isPathWithin("/root/y", "/root/x")).toBe(false);
    expect(isPathWithin("/etc/passwd", "/root/x")).toBe(false);
  });

  test("loadTieredInstructions propagates @include into project tier", async () => {
    const home = join(tmp, "home");
    const repoRoot = join(tmp, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENTS.md"), "root\n@include extra.md");
    writeFileSync(join(repoRoot, "extra.md"), "INCLUDED");
    const tiers = await loadTieredInstructions({
      cwd: repoRoot,
      homeDir: home,
      managedPath: join(tmp, "none"),
    });
    expect(tiers.project?.content).toContain("INCLUDED");
    expect(tiers.project?.content).toContain("<!-- @include extra.md -->");
  });
});
