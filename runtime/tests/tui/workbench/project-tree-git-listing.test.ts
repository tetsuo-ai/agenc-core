import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectGitBranch,
  collectGitStatus,
  consumeNulFields,
  GIT_LISTING_MAX_BYTES,
  listGitFiles,
  listingWarning,
  parseGitStatusPorcelainZ,
  shouldScanWorkspaceFallback,
} from "../../../src/tui/workbench/project-tree/gitStatus.js";
import {
  listWorkspacePaths,
  ProjectTreeStore,
} from "../../../src/tui/workbench/project-tree/ProjectTreeStore.js";

const LARGE_PATH_COUNT = 12_000;
const LARGE_PATH_PREFIX = "deep/nested/directory/file-";

describe("project-tree Git listing bounds (#2120)", () => {
  it("reassembles NUL-delimited fields across chunks, including newline names", () => {
    const first = consumeNulFields("", "src/has\nnew");
    expect(first.fields).toEqual([]);
    expect(first.pending).toBe("src/has\nnew");

    const second = consumeNulFields(first.pending, "line.ts\0README.md\0");
    expect(second.fields).toEqual(["src/has\nnewline.ts", "README.md"]);
    expect(second.pending).toBe("");
  });

  it("parses porcelain -z status for newline names and renames", () => {
    const parsed = parseGitStatusPorcelainZ(
      [
        "?? src/has\nnewline.ts",
        "R  src/new name.ts",
        "src/old name.ts",
        " M src/changed.ts",
      ].join("\0") + "\0",
    );

    expect(parsed.get("src/has\nnewline.ts")).toBe("untracked");
    expect(parsed.get("src/new name.ts")).toBe("renamed");
    expect(parsed.has("src/old name.ts")).toBe(false);
    expect(parsed.get("src/changed.ts")).toBe("modified");
  });

  it("lists more than 1 MiB of NUL-delimited ls-files and status output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-tree-git-large-"));
    try {
      const git = await writeFakeGit(
        dir,
        `
const args = process.argv.slice(2);
const count = ${LARGE_PATH_COUNT};
const paths = [];
for (let i = 0; i < count; i++) {
  paths.push("${LARGE_PATH_PREFIX}" + String(i).padStart(5, "0") + ".txt");
}
const payload = paths.join("\\0") + "\\0";
if (args.includes("ls-files")) {
  process.stdout.write(payload);
  process.exit(0);
}
if (args.includes("--porcelain=v1")) {
  process.stdout.write(paths.map((path) => "?? " + path).join("\\0") + "\\0");
  process.exit(0);
}
if (args.includes("--porcelain=v2")) {
  process.stdout.write(
    [
      "# branch.oid abcdef0123456789",
      "# branch.head main",
      ...paths.map((path) => "? " + path),
    ].join("\\n") + "\\n",
  );
  process.exit(0);
}
process.exit(1);
`,
      );

      const files = await listGitFiles(dir, { git });
      const status = await collectGitStatus(dir, { git });
      const branch = await collectGitBranch(dir, { git });
      const listedBytes = Buffer.byteLength(`${files.paths.join("\0")}\0`);

      expect(listedBytes).toBeGreaterThan(1024 * 1024);
      expect(listedBytes).toBeLessThan(GIT_LISTING_MAX_BYTES);
      expect(files).toMatchObject({
        kind: "ok",
        truncated: false,
        message: null,
      });
      expect(files.paths).toHaveLength(LARGE_PATH_COUNT);
      expect(files.paths[0]).toBe(`${LARGE_PATH_PREFIX}00000.txt`);
      expect(files.paths.at(-1)).toBe(`${LARGE_PATH_PREFIX}11999.txt`);

      expect(status.kind).toBe("ok");
      expect(status.status.size).toBe(LARGE_PATH_COUNT);
      expect(status.status.get(`${LARGE_PATH_PREFIX}00000.txt`)).toBe(
        "untracked",
      );

      expect(branch.kind).toBe("ok");
      expect(branch.branch).toMatchObject({
        branch: "main",
        head: "abcdef0",
        dirtyCount: LARGE_PATH_COUNT,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes output-limit and timeout from a non-Git workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-tree-git-kinds-"));
    try {
      const limitedGit = await writeFakeGit(
        dir,
        `
process.stdout.write("aaaaaaaa.tsx\\0bbbbbbbb.tsx\\0cccccccc.tsx\\0");
process.exit(0);
`,
      );
      const timeoutGit = await writeFakeGit(
        dir,
        `
setTimeout(() => {}, 10_000);
`,
      );
      const notGit = await listGitFiles(dir);
      const limited = await listGitFiles(dir, {
        git: limitedGit,
        maxBytes: 16,
      });
      const timedOut = await listGitFiles(dir, {
        git: timeoutGit,
        timeoutMs: 40,
      });

      expect(notGit.kind).toBe("not-git");
      expect(notGit.message).toBe("not a git repository");
      expect(limited.kind).toBe("output-limit");
      expect(limited.message).toMatch(/16 byte output bound/u);
      expect(limited.kind).not.toBe(notGit.kind);
      expect(timedOut.kind).toBe("timeout");
      expect(timedOut.message).toMatch(/timed out after 40ms/u);
      expect(timedOut.kind).not.toBe(notGit.kind);
      expect(listingWarning(notGit)).toBeNull();
      expect(listingWarning(limited)).toBe(limited.message);
      expect(listingWarning(timedOut)).toBe(timedOut.message);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists a real Git filename that contains a newline", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-git-newline-"));
    const fileName = "has\nnewline.ts";
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await writeFile(join(repo, fileName), "newline\n", "utf8");

      const files = await listGitFiles(repo);
      const status = await collectGitStatus(repo);

      expect(files.kind).toBe("ok");
      expect(files.paths).toContain(fileName);
      expect(status.status.get(fileName)).toBe("untracked");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("lists a real Git index larger than 1 MiB", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-git-index-"));
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: repo,
        input: "",
      })
        .toString("utf8")
        .trim();
      const pathCount = 16_000;
      const lines: string[] = [];
      for (let index = 0; index < pathCount; index += 1) {
        lines.push(
          `100644 ${blob} 0\t${paddedIndexPath(index)}`,
        );
      }
      execFileSync("git", ["update-index", "--index-info"], {
        cwd: repo,
        input: `${lines.join("\n")}\n`,
      });

      const files = await listGitFiles(repo);
      const listedBytes = Buffer.byteLength(`${files.paths.join("\0")}\0`);

      expect(listedBytes).toBeGreaterThan(1024 * 1024);
      expect(files.kind).toBe("ok");
      expect(files.paths).toHaveLength(pathCount);
      expect(files.paths[0]).toBe(paddedIndexPath(0));
      expect(files.paths.at(-1)).toBe(paddedIndexPath(pathCount - 1));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("does not replace a failed Git listing with the truncated filesystem scan", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-git-noscan-"));
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await mkdir(join(repo, "visible"), { recursive: true });
      await writeFile(join(repo, "visible", "keep.ts"), "keep\n", "utf8");
      await writeFile(join(repo, "scan-only.ts"), "scan\n", "utf8");

      const timeoutGit = await writeFakeGit(
        repo,
        `
setTimeout(() => {}, 10_000);
`,
      );
      const limitedGit = await writeFakeGit(
        repo,
        `
process.stdout.write("visible/keep.ts\\0extra-from-git.ts\\0");
process.exit(0);
`,
      );

      const timedOut = await listWorkspacePaths(repo, {
        git: timeoutGit,
        timeoutMs: 40,
      });
      const limited = await listWorkspacePaths(repo, {
        git: limitedGit,
        maxBytes: Buffer.byteLength("visible/keep.ts\0"),
      });
      const healthy = await listWorkspacePaths(repo);

      expect(shouldScanWorkspaceFallback(timedOut)).toBe(false);
      expect(timedOut.source).toBe("git");
      expect(timedOut.kind).toBe("timeout");
      expect(timedOut.paths).not.toContain("scan-only.ts");
      expect(timedOut.warning).toMatch(/timed out/u);

      expect(limited.source).toBe("git");
      expect(limited.kind).toBe("output-limit");
      expect(limited.paths).not.toContain("scan-only.ts");
      expect(limited.warning).toMatch(/byte output bound/u);

      expect(healthy.source).toBe("git");
      expect(healthy.kind).toBe("ok");
      expect(healthy.paths).toEqual(
        expect.arrayContaining(["visible/keep.ts", "scan-only.ts"]),
      );
      expect(healthy.warning).toBeNull();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("still scans a non-Git workspace and an empty Git index", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agenc-tree-git-scan-"));
    const emptyGit = await mkdtemp(join(tmpdir(), "agenc-tree-empty-git-"));
    try {
      await mkdir(join(workspace, "src"), { recursive: true });
      await writeFile(join(workspace, "src", "app.ts"), "app\n", "utf8");
      execFileSync("git", ["init"], { cwd: emptyGit, stdio: "ignore" });
      await mkdir(join(emptyGit, "src", "empty"), { recursive: true });

      const scanned = await listWorkspacePaths(workspace);
      const emptyIndex = await listWorkspacePaths(emptyGit);

      expect(scanned.source).toBe("scan");
      expect(scanned.kind).toBe("not-git");
      expect(scanned.paths).toContain("src/app.ts");
      expect(emptyIndex.source).toBe("scan");
      expect(emptyIndex.kind).toBe("ok");
      expect(emptyIndex.paths).toContain("src/empty");
      expect(emptyIndex.warning).toBeNull();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(emptyGit, { recursive: true, force: true });
    }
  });

  it("surfaces a Git timeout on the project tree instead of a silent scan", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-store-timeout-"));
    const timeoutGit = await writeFakeGit(
      repo,
      `
setTimeout(() => {}, 10_000);
`,
    );
    const store = new ProjectTreeStore(repo, 0, {
      git: timeoutGit,
      timeoutMs: 40,
    });
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await writeFile(join(repo, "hidden-by-scan.ts"), "hidden\n", "utf8");

      await store.refresh();
      const snapshot = store.getSnapshot();
      const paths = snapshot.rows.map((row) => row.path);

      expect(snapshot.error).toMatch(/timed out after 40ms/u);
      expect(paths).not.toContain("hidden-by-scan.ts");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("keeps a bounded Git listing visible on the project tree", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-store-bound-"));
    const git = await writeFakeGit(
      repo,
      `
if (process.argv.includes("ls-files")) {
  process.stdout.write("kept.ts\\0dropped.ts\\0");
  process.exit(0);
}
if (process.argv.includes("--porcelain=v2")) {
  process.stdout.write("# branch.oid abcdef0\\n# branch.head main\\n");
  process.exit(0);
}
process.exit(0);
`,
    );
    const store = new ProjectTreeStore(repo, 0, {
      git,
      maxEntries: 1,
    });
    try {
      await writeFile(join(repo, "scan-only.ts"), "scan\n", "utf8");

      await store.refresh();
      const snapshot = store.getSnapshot();
      const paths = snapshot.rows.map((row) => row.path);

      expect(snapshot.error).toMatch(/truncated at 1 files/u);
      expect(paths).toContain("kept.ts");
      expect(paths).not.toContain("dropped.ts");
      expect(paths).not.toContain("scan-only.ts");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });
});

function paddedIndexPath(index: number): string {
  const stem = `tracked/dir/file-${String(index).padStart(5, "0")}-`;
  return `${stem}${"x".repeat(64)}.txt`;
}

async function writeFakeGit(dir: string, source: string): Promise<string> {
  const git = join(dir, `fake-git-${Math.random().toString(16).slice(2)}`);
  await writeFile(git, `#!/usr/bin/env node\n${source}\n`, {
    encoding: "utf8",
    mode: 0o755,
  });
  await chmod(git, 0o755);
  return git;
}
