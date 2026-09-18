import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectGitBranch,
  collectGitSnapshot,
  collectGitStatus,
  parseGitBranchPorcelainV2,
  parseGitSnapshotPorcelainV2,
  parseGitStatusPorcelain,
  parseGitStatusPorcelainZ,
} from "../../../../src/tui/workbench/project-tree/gitStatus.js";

const UNMERGED_CODES = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];
const HEAD = "e8bb66f40697f8f12499bbcbce67d7f32c3bbb23";
const TRACKED_FIELDS = "N... 100644 100644 100644 aaa bbb";
const UNMERGED_FIELDS = "N... 100644 100644 100644 100644 aaa bbb ccc";

function v2(...records: string[]): string {
  return ["# branch.oid " + HEAD, "# branch.head main", ...records, ""].join("\0");
}

describe("project tree porcelain v1 conflict classification", () => {
  for (const [format, parse, delimiter] of [
    ["newline", parseGitStatusPorcelain, "\n"],
    ["NUL", parseGitStatusPorcelainZ, "\0"],
  ] as const) {
    it.each(UNMERGED_CODES)(`recognizes %s as unmerged in ${format} output`, (code) => {
      expect(parse(`${code} conflict.ts${delimiter}`)).toEqual(
        new Map([["conflict.ts", "unmerged"]]),
      );
    });

    it(`retains ordinary added and deleted states in ${format} output`, () => {
      expect(parse([
        "A  added.ts", " D deleted.ts", "AD added-then-deleted.ts", "",
      ].join(delimiter))).toEqual(new Map([
        ["added.ts", "added"],
        ["deleted.ts", "deleted"],
        ["added-then-deleted.ts", "deleted"],
      ]));
    });
  }

  it("consumes rename and copy origins without parsing them as changes", () => {
    const raw = [
      "R  renamed -> target.ts", "?? rename origin.ts",
      "C  copied.ts", "AA copy origin.ts",
      " M  changed\nfile.ts ", "",
    ].join("\0");
    expect(parseGitStatusPorcelainZ(raw)).toEqual(new Map([
      ["renamed -> target.ts", "renamed"],
      ["copied.ts", "modified"],
      [" changed\nfile.ts ", "modified"],
    ]));
  });
});

describe("project tree porcelain v2 snapshot", () => {
  it("derives file states, branch, divergence and dirty count from NUL records", () => {
    const raw = v2(
      "# branch.upstream origin/main",
      "# branch.ab +12 -3",
      "# future.header ignored",
      `1 .M ${TRACKED_FIELDS} changed.ts`,
      `1 A. ${TRACKED_FIELDS} added.ts`,
      `1 .D ${TRACKED_FIELDS} deleted.ts`,
      `2 R. ${TRACKED_FIELDS} R100 renamed.ts`,
      "? origin-that-looks-like-a-record.ts",
      `2 C. ${TRACKED_FIELDS} C75 copied.ts`,
      "# branch.head not-the-branch",
      `u AA ${UNMERGED_FIELDS} conflict.ts`,
      "? untracked.ts",
      "! ignored.ts",
    );
    const snapshot = parseGitSnapshotPorcelainV2(raw);

    expect(snapshot.status).toEqual(new Map([
      ["changed.ts", "modified"],
      ["added.ts", "added"],
      ["deleted.ts", "deleted"],
      ["renamed.ts", "renamed"],
      ["copied.ts", "modified"],
      ["conflict.ts", "unmerged"],
      ["untracked.ts", "untracked"],
      ["ignored.ts", "ignored"],
    ]));
    expect(snapshot.branch).toEqual({
      branch: "main", head: HEAD.slice(0, 7), upstream: "origin/main",
      ahead: 12, behind: 3, dirtyCount: 7,
    });
    expect(parseGitBranchPorcelainV2(raw)).toEqual(snapshot.branch);
  });

  it.each(UNMERGED_CODES)("recognizes v2 unmerged %s records", (code) => {
    const snapshot = parseGitSnapshotPorcelainV2(v2(`u ${code} ${UNMERGED_FIELDS} conflict.ts`));
    expect(snapshot.status.get("conflict.ts")).toBe("unmerged");
    expect(snapshot.branch?.dirtyCount).toBe(1);
  });

  it("preserves whitespace, quotes, Unicode and newlines in every NUL path format", () => {
    const tracked = ' tracked\tfile\nwith "quotes".ts ';
    const renamed = " renamed -> file\n.ts ";
    const conflict = " conflict\tfile.ts ";
    const untracked = " untracked\n# branch.head fake\né.ts ";
    const snapshot = parseGitSnapshotPorcelainV2(v2(
      `1 .M ${TRACKED_FIELDS} ${tracked}`,
      `2 R. ${TRACKED_FIELDS} R100 ${renamed}`,
      "? old\norigin.ts",
      `u DD ${UNMERGED_FIELDS} ${conflict}`,
      `? ${untracked}`,
    ));

    expect(snapshot.status).toEqual(new Map([
      [tracked, "modified"], [renamed, "renamed"],
      [conflict, "unmerged"], [untracked, "untracked"],
    ]));
    expect(snapshot.branch).toEqual({ branch: "main", head: HEAD.slice(0, 7), dirtyCount: 4 });
  });

  it("accepts legacy newline branch input and tab-separated rename origins", () => {
    const snapshot = parseGitSnapshotPorcelainV2([
      "# branch.oid " + HEAD, "# branch.head main",
      `2 R. ${TRACKED_FIELDS} R100 renamed.ts\toriginal.ts`,
      `2 C. ${TRACKED_FIELDS} C100 copied.ts\toriginal.ts`,
      "? new.ts", "",
    ].join("\n"));
    expect(snapshot.status).toEqual(new Map([
      ["renamed.ts", "renamed"], ["copied.ts", "modified"], ["new.ts", "untracked"],
    ]));
    expect(snapshot.branch?.dirtyCount).toBe(3);
  });

  it.each(["\n", "\0"])("handles detached and unborn branches with %j separators", (separator) => {
    expect(parseGitBranchPorcelainV2([
      "# branch.oid " + HEAD, "# branch.head (detached)", "",
    ].join(separator))).toEqual({ branch: null, head: HEAD.slice(0, 7), dirtyCount: 0 });
    expect(parseGitBranchPorcelainV2([
      "# branch.oid (initial)", "# branch.head main", "? new.ts", "",
    ].join(separator))).toEqual({ branch: "main", head: null, dirtyCount: 1 });
  });

  it("ignores unknown records, truncated records and invalid divergence", () => {
    const snapshot = parseGitSnapshotPorcelainV2(v2(
      "# branch.ab unknown", "# stash 2", "future arbitrary fields", "1 .M incomplete", "? ",
    ));
    expect(snapshot.status.size).toBe(0);
    expect(snapshot.branch).toEqual({ branch: "main", head: HEAD.slice(0, 7), dirtyCount: 0 });
  });

  it.each(["", "fatal: not a git repository\n"])("returns an empty snapshot for %j", (raw) => {
    expect(parseGitSnapshotPorcelainV2(raw)).toEqual({ status: new Map(), branch: null });
  });
});

describe("project tree Git snapshot collection", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function tempDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "agenc-tree-git-snapshot-"));
    directories.push(directory);
    return directory;
  }

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  it("collects real NUL output for an unborn branch and a staged rename", async () => {
    const repo = await tempDirectory();
    git(repo, "init", "-b", "main");
    const source = " original -> file\n.ts ";
    const target = ' renamed\tfile\n"é".ts ';
    await writeFile(join(repo, source), "initial contents\n");

    expect(await collectGitSnapshot(repo)).toEqual({
      status: new Map([[source, "untracked"]]),
      branch: { branch: "main", head: null, dirtyCount: 1 },
    });

    git(repo, "add", "--", source);
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--no-gpg-sign", "-m", "initial");
    git(repo, "mv", "--", source, target);

    const snapshot = await collectGitSnapshot(repo);
    expect(snapshot.status).toEqual(new Map([[target, "renamed"]]));
    expect(snapshot.branch).toEqual({
      branch: "main", head: git(repo, "rev-parse", "HEAD").trim().slice(0, 7), dirtyCount: 1,
    });
    expect(await collectGitStatus(repo)).toEqual(snapshot.status);
    expect(await collectGitBranch(repo)).toEqual(snapshot.branch);
  });

  it("retains repository-root-relative paths when invoked from a subdirectory", async () => {
    const repo = await tempDirectory();
    git(repo, "init", "-b", "main");
    await mkdir(join(repo, "subdir"));
    await writeFile(join(repo, "subdir", "new.ts"), "contents\n");
    await writeFile(join(repo, "root.ts"), "contents\n");

    expect((await collectGitSnapshot(join(repo, "subdir"))).status).toEqual(new Map([
      ["root.ts", "untracked"], ["subdir/new.ts", "untracked"],
    ]));
  });

  it("retains tracked changes when v2 metadata exceeds the default process buffer", async () => {
    const repo = await tempDirectory();
    git(repo, "init", "-b", "main");
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo, input: "contents\n", encoding: "utf8",
    }).trim();
    const paths = Array.from({ length: 9_000 }, (_, index) => `tracked-${String(index).padStart(5, "0")}.ts`);
    // Seed one shared blob into the index without writing thousands of files.
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: repo,
      input: paths.map((path) => `100644 ${blob}\t${path}\n`).join(""),
    });
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--no-gpg-sign", "-m", "initial");

    const v1 = git(repo, "status", "--porcelain=v1", "-z");
    const v2 = execFileSync("git", ["status", "--porcelain=v2", "--branch", "-z"], {
      cwd: repo, maxBuffer: 2 * 1024 * 1024,
    });
    expect(Buffer.byteLength(v1)).toBeLessThan(1024 * 1024);
    expect(v2.length).toBeGreaterThan(1024 * 1024);

    const snapshot = await collectGitSnapshot(repo);
    expect(snapshot.status.size).toBe(paths.length);
    expect([...snapshot.status.values()].every((state) => state === "deleted")).toBe(true);
    expect(snapshot.branch).toMatchObject({ branch: "main", dirtyCount: paths.length });
  });

  it("returns an empty snapshot outside a repository and for an invalid cwd", async () => {
    const directory = await tempDirectory();
    await expect(collectGitSnapshot(directory)).resolves.toEqual({ status: new Map(), branch: null });
    await expect(collectGitSnapshot(join(directory, "missing"))).resolves.toEqual({ status: new Map(), branch: null });
  });
});
