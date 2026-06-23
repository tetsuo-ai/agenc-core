import { execFileSync } from "node:child_process";
import {
  chmodSync,
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
  assembleTieredInstructions,
  clearTieredInstructionsCacheForTesting,
  formatTieredInstructionWarnings,
  isPathWithin,
  loadTieredInstructions,
  resolveIncludes,
  type TierEntry,
  type TieredInstructions,
} from "./agenc-md.js";

const POSIX = platform() !== "win32";
const posixTest = POSIX ? test : test.skip;

describe("agenc-md (T10-B tiered + @include)", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agenc-md-"));
    // Clear the mtime cache so tests are independent. Each test
    // mints a fresh tmpdir, but because the cache is module-scope it
    // would otherwise persist across runs in the same process.
    clearTieredInstructionsCacheForTesting();
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
    writeFileSync(join(home, ".agenc", "AGENC.md"), "USER");
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENC.md"), "PROJECT");
    writeFileSync(join(repoRoot, "AGENC.local.md"), "LOCAL");

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
    writeFileSync(join(repoRoot, "AGENC.md"), "project only");

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

  test("loadTieredInstructions ignores non-AgenC user instruction files", async () => {
    const home = join(tmp, "home");
    const repoRoot = join(tmp, "repo");
    mkdirSync(join(home, ".agenc"), { recursive: true });
    mkdirSync(join(home, ".config", "assistant"), { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(home, ".agenc", "TEAM-INSTRUCTIONS.md"), "TEAM");
    writeFileSync(join(home, ".config", "assistant", "INSTRUCTIONS.md"), "OTHER");
    writeFileSync(join(repoRoot, "package.json"), "{}");

    const tiers = await loadTieredInstructions({
      cwd: repoRoot,
      homeDir: home,
      managedPath: join(tmp, "none"),
    });
    expect(tiers.user).toBeNull();
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
      managed: mk("managed", "/etc/agenc/AGENC.md", "M"),
      user: mk("user", "/home/u/.agenc/AGENC.md", "U"),
      project: mk("project", "/r/AGENC.md", "P"),
      local: mk("local", "/r/AGENC.local.md", "L"),
    };
    const text = assembleTieredInstructions(tiers);
    // Each tier header includes the path.
    expect(text).toContain("--- managed (/etc/agenc/AGENC.md) ---");
    expect(text).toContain("--- user (/home/u/.agenc/AGENC.md) ---");
    expect(text).toContain("--- project (/r/AGENC.md) ---");
    expect(text).toContain("--- local (/r/AGENC.local.md) ---");
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
        path: "/r/AGENC.md",
        content: "only me",
        rawContent: "only me",
        dropped: [],
      },
      local: null,
    };
    const text = assembleTieredInstructions(tiers);
    expect(text).toContain("--- project (/r/AGENC.md) ---");
    expect(text).toContain("only me");
    expect(text).not.toContain("--- managed");
  });

  test("formatTieredInstructionWarnings reports dropped includes from loaded tiers", () => {
    const warnings = formatTieredInstructionWarnings({
      managed: null,
      user: null,
      project: {
        tier: "project",
        path: "/repo/AGENC.md",
        content: "",
        rawContent: "",
        dropped: [
          {
            requestedPath: "../secret.md",
            reason: "path_escape",
            includingFile: "/repo/AGENC.md",
          },
        ],
      },
      local: null,
    });

    expect(warnings).toEqual([
      "AGENC.md include dropped: ../secret.md (path_escape from /repo/AGENC.md)",
    ]);
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
    // Rejection marker left so the drop is visible downstream.
    expect(res.text).toContain(
      "<!-- @include ../outside/secret.md (rejected: path_escape) -->",
    );
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
    // Positive: in-bounds files (depth <= maxDepth) ARE inlined. With
    // maxDepth:2 the guard is `depth+1 > max`, so f0 (->1) and f1 (->2)
    // inline; f1's ok-marker only appears if f0 was expanded.
    expect(res.text).toContain("<!-- @include f1.md -->");
    // Negative: the over-depth file f2 (->3 > 2) is rejected, not inlined,
    // and the deepest LEAF body (in f4) is never reached/inlined.
    expect(res.text).toContain("<!-- @include f2.md (rejected: max_depth");
    expect(res.text).not.toContain("<!-- @include f2.md -->");
    expect(res.text).not.toContain("LEAF");
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
    expect(res.text).toContain("<!-- @include big.md (rejected: max_bytes");
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
    expect(res.text).toContain(
      "<!-- @include nope.md (rejected: not_found) -->",
    );
  });

  test("isPathWithin boundary check rejects `..` escapes and absolute escapes", () => {
    expect(isPathWithin("/root/x/y", "/root/x")).toBe(true);
    expect(isPathWithin("/root/x", "/root/x")).toBe(true);
    expect(isPathWithin("/root/y", "/root/x")).toBe(false);
    expect(isPathWithin("/etc/passwd", "/root/x")).toBe(false);
  });

  // ---- T10 Fix-B: realpath boundary + non-regular file rejection ----

  posixTest(
    "I-75 realpath: symlink inside project pointing outside is rejected",
    async () => {
      const repo = join(tmp, "repo");
      const outside = join(tmp, "outside");
      mkdirSync(repo);
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.md"), "SECRET");
      // Attack: in-tree name, out-of-tree target.
      symlinkSync(join(outside, "secret.md"), join(repo, "leak.md"));
      const res = await resolveIncludes("@include leak.md", {
        baseDir: repo,
        projectRoot: repo,
      });
      expect(res.included).toHaveLength(0);
      expect(res.dropped).toHaveLength(1);
      expect(res.dropped[0]!.reason).toBe("path_escape");
      expect(res.text).not.toContain("SECRET");
      expect(res.text).toContain(
        "<!-- @include leak.md (rejected: path_escape) -->",
      );
    },
  );

  posixTest("broken symlink is rejected (not_found)", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    symlinkSync(join(tmp, "does-not-exist"), join(repo, "dangling.md"));
    const res = await resolveIncludes("@include dangling.md", {
      baseDir: repo,
      projectRoot: repo,
    });
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0]!.reason).toBe("not_found");
    expect(res.text).toContain(
      "<!-- @include dangling.md (rejected: not_found) -->",
    );
  });

  test("null-byte in @include path is rejected as invalid_path", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "safe.md"), "SAFE");
    // Raw null byte smuggled through the directive line.
    const res = await resolveIncludes("@include safe\0.md", {
      baseDir: repo,
      projectRoot: repo,
    });
    expect(res.included).toHaveLength(0);
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0]!.reason).toBe("invalid_path");
    expect(res.text).not.toContain("SAFE");
  });

  posixTest("FIFO under project root is rejected (not_regular_file)", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const fifo = join(repo, "pipe.md");
    execFileSync("mkfifo", [fifo]);
    const res = await resolveIncludes("@include pipe.md", {
      baseDir: repo,
      projectRoot: repo,
    });
    expect(res.included).toHaveLength(0);
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0]!.reason).toBe("not_regular_file");
    expect(res.text).toContain(
      "<!-- @include pipe.md (rejected: not_regular_file) -->",
    );
  });

  posixTest(
    "symlink to character device (/dev/null) is rejected via realpath boundary",
    async () => {
      const repo = join(tmp, "repo");
      mkdirSync(repo);
      symlinkSync("/dev/null", join(repo, "dev.md"));
      const res = await resolveIncludes("@include dev.md", {
        baseDir: repo,
        projectRoot: repo,
      });
      expect(res.included).toHaveLength(0);
      expect(res.dropped).toHaveLength(1);
      // realpath resolves through the symlink; `/dev/null` is outside the
      // project boundary, so the boundary check fires first.
      expect(res.dropped[0]!.reason).toBe("path_escape");
    },
  );

  posixTest(
    "in-tree symlink to in-tree regular file still works (sanity)",
    async () => {
      const repo = join(tmp, "repo");
      mkdirSync(repo);
      writeFileSync(join(repo, "real.md"), "REAL");
      symlinkSync(join(repo, "real.md"), join(repo, "alias.md"));
      const res = await resolveIncludes("@include alias.md", {
        baseDir: repo,
        projectRoot: repo,
      });
      expect(res.dropped).toHaveLength(0);
      expect(res.text).toContain("REAL");
    },
  );

  test("circular @include emits rejection marker", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "a.md"), "A\n@include b.md");
    writeFileSync(join(repo, "b.md"), "B\n@include a.md");
    const res = await resolveIncludes("@include a.md", {
      baseDir: repo,
      projectRoot: repo,
    });
    const cyc = res.dropped.find((d) => d.reason === "circular");
    expect(cyc).toBeDefined();
    expect(res.text).toContain("(rejected: circular");
    expect(res.text).toContain("@include a.md");
  });

  test("max_depth rejection emits marker with depth info", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "a.md"), "A\n@include b.md");
    writeFileSync(join(repo, "b.md"), "B\n@include c.md");
    writeFileSync(join(repo, "c.md"), "C");
    const res = await resolveIncludes("@include a.md", {
      baseDir: repo,
      projectRoot: repo,
      maxDepth: 1,
    });
    expect(res.dropped.some((d) => d.reason === "max_depth")).toBe(true);
    expect(res.text).toContain("(rejected: max_depth");
    expect(res.text).toContain("depth=");
  });

  test("max_bytes rejection emits marker with cap info", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "big.md"), "x".repeat(2048));
    const res = await resolveIncludes("@include big.md", {
      baseDir: repo,
      projectRoot: repo,
      maxBytes: 256,
    });
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0]!.reason).toBe("max_bytes");
    expect(res.text).toContain("(rejected: max_bytes");
    expect(res.text).toContain("cap=256B");
  });

  // ---- T10 A+ Fix-γ: URI-encoded traversal, EACCES mid-walk, read_error ----

  test(
    "URI-encoded traversal `%2E%2E` is NOT decoded (treated literally, not_found)",
    async () => {
      const repo = join(tmp, "repo");
      const outside = join(tmp, "outside");
      mkdirSync(repo);
      mkdirSync(outside);
      writeFileSync(join(outside, "a.md"), "SECRET");
      // `.%2E/a.md` — if decoded, this would be `../a.md` escaping the repo.
      // We assert NO decoding happens: the literal segment `.%2E` does not
      // exist inside the repo, so the target resolves to a missing file and
      // is dropped as `not_found`, not `path_escape`. Either way, no
      // SECRET content leaks into the expansion output.
      const res = await resolveIncludes("@include .%2E/a.md", {
        baseDir: repo,
        projectRoot: repo,
      });
      expect(res.included).toHaveLength(0);
      expect(res.dropped).toHaveLength(1);
      // Literal segment `.%2E` lives under the repo lexically, realpath of
      // the missing candidate fails, so boundary check fails closed and we
      // probe existence → `not_found`.
      expect(res.dropped[0]!.reason).toBe("not_found");
      expect(res.text).not.toContain("SECRET");
      expect(res.text).toContain(
        "<!-- @include .%2E/a.md (rejected: not_found) -->",
      );
    },
  );

  posixTest(
    "EACCES mid-walk: parent dir becomes unreadable → fail-closed (not_found)",
    async () => {
      const repo = join(tmp, "repo");
      const locked = join(repo, "locked");
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, "unreachable.md"), "HIDDEN");
      // Lock the parent directory so realpath/stat on the child fails
      // with EACCES mid-walk. Use chmod 000 to block both read and
      // traverse permissions.
      chmodSync(locked, 0o000);
      try {
        const res = await resolveIncludes("@include locked/unreachable.md", {
          baseDir: repo,
          projectRoot: repo,
        });
        expect(res.included).toHaveLength(0);
        expect(res.dropped).toHaveLength(1);
        // Fail-closed: realpath EACCES returns false from isPathWithinReal,
        // then pathExists also fails, so we report `not_found`. Either way
        // the file contents never leak.
        expect(res.dropped[0]!.reason).toBe("not_found");
        expect(res.text).not.toContain("HIDDEN");
      } finally {
        // Restore perms so rmSync cleanup in afterEach succeeds.
        chmodSync(locked, 0o755);
      }
    },
  );

  posixTest(
    "read_error marker emitted when file is stat-able but not readable",
    async () => {
      const repo = join(tmp, "repo");
      mkdirSync(repo);
      const unreadable = join(repo, "locked.md");
      writeFileSync(unreadable, "SENSITIVE");
      // Mode 000: stat() succeeds (parent dir readable/traversable) but
      // open() for read fails with EACCES → resolveIncludes hits the
      // `readTextFile` catch and drops with `read_error`, emitting the
      // rejection marker.
      chmodSync(unreadable, 0o000);
      try {
        const res = await resolveIncludes("@include locked.md", {
          baseDir: repo,
          projectRoot: repo,
        });
        expect(res.included).toHaveLength(0);
        expect(res.dropped).toHaveLength(1);
        expect(res.dropped[0]!.reason).toBe("read_error");
        expect(res.text).not.toContain("SENSITIVE");
        expect(res.text).toContain(
          "<!-- @include locked.md (rejected: read_error) -->",
        );
      } finally {
        chmodSync(unreadable, 0o644);
      }
    },
  );

  test("loadTieredInstructions propagates @include into project tier", async () => {
    const home = join(tmp, "home");
    const repoRoot = join(tmp, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENC.md"), "root\n@include extra.md");
    writeFileSync(join(repoRoot, "extra.md"), "INCLUDED");
    const tiers = await loadTieredInstructions({
      cwd: repoRoot,
      homeDir: home,
      managedPath: join(tmp, "none"),
    });
    expect(tiers.project?.content).toContain("INCLUDED");
    expect(tiers.project?.content).toContain("<!-- @include extra.md -->");
  });

  test("loadTieredInstructions prefers AGENC.md and falls back to AGENTS.md only", async () => {
    const home = join(tmp, "home");
    const repoRoot = join(tmp, "repo");
    const nested = join(repoRoot, "nested");
    mkdirSync(home, { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENTS.md"), "ROOT-AGENTS");
    writeFileSync(join(repoRoot, "CLAUDE.md"), "ROOT-OLD");
    writeFileSync(join(nested, "AGENC.md"), "NESTED-AGENC");

    let tiers = await loadTieredInstructions({
      cwd: nested,
      homeDir: home,
      managedPath: join(tmp, "none"),
    });
    expect(tiers.project?.content).toContain("ROOT-AGENTS");
    expect(tiers.project?.content).toContain("NESTED-AGENC");
    expect(tiers.project?.content).not.toContain("ROOT-OLD");
    expect(tiers.project?.path).toBe(join(nested, "AGENC.md"));

    rmSync(join(nested, "AGENC.md"), { force: true });
    rmSync(join(repoRoot, "AGENTS.md"), { force: true });

    tiers = await loadTieredInstructions({
      cwd: nested,
      homeDir: home,
      managedPath: join(tmp, "none"),
    });
    expect(tiers.project).toBeNull();
  });

  test("loadTieredInstructions walks project docs from root to cwd", async () => {
    const home = join(tmp, "home");
    const repoRoot = join(tmp, "repo");
    const pkgDir = join(repoRoot, "packages", "api");
    mkdirSync(home, { recursive: true });
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENC.md"), "ROOT");
    writeFileSync(join(pkgDir, "AGENC.md"), "PKG");

    const tiers = await loadTieredInstructions({
      cwd: pkgDir,
      homeDir: home,
      managedPath: join(tmp, "none"),
    });
    expect(tiers.project?.content).toContain("--- project-doc");
    expect(tiers.project?.content).toContain("ROOT");
    expect(tiers.project?.content).toContain("PKG");
    expect(tiers.project?.path).toBe(join(pkgDir, "AGENC.md"));
  });

  test("loadTieredInstructions includes unconditional .agenc/rules project rules", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-md-rules-"));
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, "AGENC.md"), "ROOT");
      mkdirSync(join(root, ".agenc", "rules"), { recursive: true });
      writeFileSync(join(root, ".agenc", "rules", "always.md"), "# Always rule\n");

      const tiers = await loadTieredInstructions({
        cwd: root,
        homeDir: join(root, "home"),
        managedPath: join(root, "managed", "AGENC.md"),
      });
      expect(tiers.project?.content).toContain("ROOT");
      expect(tiers.project?.content).toContain("# Always rule");
      expect(tiers.project?.content).toContain(".agenc/rules/always.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadTieredInstructions finds local tier from project root without project instructions", async () => {
    const home = join(tmp, "home");
    const repoRoot = join(tmp, "repo");
    const nested = join(repoRoot, "packages", "api");
    mkdirSync(home, { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENC.local.md"), "LOCAL-ROOT");

    const tiers = await loadTieredInstructions({
      cwd: nested,
      homeDir: home,
      managedPath: join(tmp, "none"),
    });

    expect(tiers.project).toBeNull();
    expect(tiers.local?.path).toBe(join(repoRoot, "AGENC.local.md"));
    expect(tiers.local?.content).toBe("LOCAL-ROOT");
  });

  test("loadTieredInstructions honors an explicit empty marker list as cwd-only", async () => {
    const home = join(tmp, "home");
    const repoRoot = join(tmp, "repo");
    const pkgDir = join(repoRoot, "packages", "api");
    mkdirSync(home, { recursive: true });
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "AGENC.md"), "ROOT");
    writeFileSync(join(pkgDir, "AGENC.md"), "PKG");

    const tiers = await loadTieredInstructions({
      cwd: pkgDir,
      homeDir: home,
      managedPath: join(tmp, "none"),
      projectRootMarkers: [],
    });
    expect(tiers.project?.content).toBe("PKG");
    expect(tiers.project?.path).toBe(join(pkgDir, "AGENC.md"));
  });

  describe("mtime-keyed cache (avoids re-reading AGENC.md every turn)", () => {
    test("returns the same TieredInstructions object on a second call when files are unchanged", async () => {
      const home = join(tmp, "home");
      const repo = join(tmp, "repo");
      mkdirSync(home, { recursive: true });
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "package.json"), "{}");
      writeFileSync(join(repo, "AGENC.md"), "first");

      const opts = {
        cwd: repo,
        homeDir: home,
        managedPath: join(tmp, "none-managed"),
      };
      const a = await loadTieredInstructions(opts);
      const b = await loadTieredInstructions(opts);

      // Reference equality is the strongest signal that the cache
      // returned the same object — no re-read happened. (Even an
      // unchanged disk would synthesize a new TieredInstructions
      // object if loadTieredInstructionsUncached ran again.)
      expect(b).toBe(a);
      expect(a.project?.content).toBe("first");
    });

    test("invalidates when an AGENC.md mtime advances", async () => {
      const home = join(tmp, "home");
      const repo = join(tmp, "repo");
      mkdirSync(home, { recursive: true });
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "package.json"), "{}");
      writeFileSync(join(repo, "AGENC.md"), "first");

      const opts = {
        cwd: repo,
        homeDir: home,
        managedPath: join(tmp, "none-managed"),
      };
      const a = await loadTieredInstructions(opts);
      expect(a.project?.content).toBe("first");

      // Force a future mtime so node's millisecond-resolution stat
      // sees a meaningful difference even on filesystems that round
      // mtimes (HFS+, ext4 with old kernels). 2 seconds in the future
      // is far above any practical filesystem rounding.
      const futureMs = Math.floor(Date.now() / 1000) + 2;
      writeFileSync(join(repo, "AGENC.md"), "second");
      execFileSync("touch", ["-d", `@${futureMs}`, join(repo, "AGENC.md")]);

      const b = await loadTieredInstructions(opts);
      expect(b).not.toBe(a);
      expect(b.project?.content).toBe("second");
    });

    test("invalidates when a previously-missing AGENC.md is created mid-session", async () => {
      const home = join(tmp, "home");
      const repo = join(tmp, "repo");
      mkdirSync(home, { recursive: true });
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "package.json"), "{}");
      // No AGENC.md yet.

      const opts = {
        cwd: repo,
        homeDir: home,
        managedPath: join(tmp, "none-managed"),
        projectRootMarkers: [],
      };
      const a = await loadTieredInstructions(opts);
      expect(a.project).toBeNull();

      // Operator creates an AGENC.md mid-session.
      writeFileSync(join(repo, "AGENC.md"), "freshly authored");

      const b = await loadTieredInstructions(opts);
      expect(b.project?.content).toBe("freshly authored");
    });

    test("invalidates when AGENC.md is deleted mid-session", async () => {
      const home = join(tmp, "home");
      const repo = join(tmp, "repo");
      mkdirSync(home, { recursive: true });
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "package.json"), "{}");
      writeFileSync(join(repo, "AGENC.md"), "transient");

      const opts = {
        cwd: repo,
        homeDir: home,
        managedPath: join(tmp, "none-managed"),
      };
      const a = await loadTieredInstructions(opts);
      expect(a.project?.content).toBe("transient");

      rmSync(join(repo, "AGENC.md"));

      const b = await loadTieredInstructions(opts);
      expect(b.project).toBeNull();
    });

    test("different cwds get independent cache entries", async () => {
      const home = join(tmp, "home");
      const repoA = join(tmp, "repoA");
      const repoB = join(tmp, "repoB");
      mkdirSync(home, { recursive: true });
      mkdirSync(repoA, { recursive: true });
      mkdirSync(repoB, { recursive: true });
      writeFileSync(join(repoA, "package.json"), "{}");
      writeFileSync(join(repoB, "package.json"), "{}");
      writeFileSync(join(repoA, "AGENC.md"), "from A");
      writeFileSync(join(repoB, "AGENC.md"), "from B");

      const baseOpts = {
        homeDir: home,
        managedPath: join(tmp, "none-managed"),
      };
      const a1 = await loadTieredInstructions({ ...baseOpts, cwd: repoA });
      const b1 = await loadTieredInstructions({ ...baseOpts, cwd: repoB });
      const a2 = await loadTieredInstructions({ ...baseOpts, cwd: repoA });
      const b2 = await loadTieredInstructions({ ...baseOpts, cwd: repoB });

      expect(a1.project?.content).toBe("from A");
      expect(b1.project?.content).toBe("from B");
      expect(a2).toBe(a1);
      expect(b2).toBe(b1);
    });
  });
});
