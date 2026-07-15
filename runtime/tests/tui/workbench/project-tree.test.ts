import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  buildProjectTreeRows,
  getStructureBuildCountForTest,
  resetStructureBuildCountForTest,
} from "../../../src/tui/workbench/project-tree/buildTree.js";
import { collectGitStatus, listGitFiles, parseGitStatusPorcelain } from "../../../src/tui/workbench/project-tree/gitStatus.js";
import {
  ProjectTreeStore,
  scanWorkspacePaths,
} from "../../../src/tui/workbench/project-tree/ProjectTreeStore.js";

describe("project tree helpers", () => {
  it("reuses the sorted structure across cursor moves and rebuilds on a paths change (M-TUI-11)", () => {
    const paths = ["src/index.ts", "src/tui/App.tsx", "README.md"];
    const base = {
      cwd: "/repo",
      paths, // same array reference across cursor moves
      expandedPaths: new Set(["src", "src/tui"]),
      activePath: null,
      attachedPaths: new Set<string>(),
      searchHitPaths: new Set<string>(),
      inFlightPaths: new Set<string>(),
    };

    resetStructureBuildCountForTest();
    const a = buildProjectTreeRows({ ...base, cursorPath: "src/index.ts" });
    const b = buildProjectTreeRows({ ...base, cursorPath: "src/tui/App.tsx" });
    const c = buildProjectTreeRows({ ...base, cursorPath: "README.md" });

    // The O(N log N) structure build runs ONCE; cursor moves reuse it.
    expect(getStructureBuildCountForTest()).toBe(1);

    // Correctness preserved: the cursor flag tracks the requested path.
    expect(a.find((r) => r.path === "src/index.ts")?.selected).toBe(true);
    expect(b.find((r) => r.path === "src/tui/App.tsx")?.selected).toBe(true);
    expect(c.find((r) => r.path === "README.md")?.selected).toBe(true);
    expect(b.find((r) => r.path === "src/index.ts")?.selected).toBe(false);

    // A new paths array (file-list change) forces a rebuild.
    buildProjectTreeRows({ ...base, paths: [...paths], cursorPath: "README.md" });
    expect(getStructureBuildCountForTest()).toBe(2);
  });

  it("builds expandable rows from synthetic paths", () => {
    const rows = buildProjectTreeRows({
      cwd: "/repo",
      paths: ["src/index.ts", "src/tui/App.tsx", "README.md"],
      expandedPaths: new Set(["src", "src/tui"]),
      cursorPath: "src/index.ts",
      activePath: "README.md",
      attachedPaths: new Set(["src/tui/App.tsx"]),
      searchHitPaths: new Set(["src/index.ts"]),
      inFlightPaths: new Set(),
    });

    expect(rows.map((row) => [row.path, row.kind, row.depth])).toEqual([
      ["", "root", 0],
      ["src", "directory", 1],
      ["src/tui", "directory", 2],
      ["src/tui/App.tsx", "file", 3],
      ["src/index.ts", "file", 2],
      ["README.md", "file", 1],
    ]);
    expect(rows.find((row) => row.path === "src/index.ts")).toMatchObject({
      selected: true,
      searchHit: true,
    });
    expect(rows.find((row) => row.path === "README.md")).toMatchObject({
      active: true,
    });
    expect(rows.find((row) => row.path === "src/tui/App.tsx")).toMatchObject({
      attached: true,
      ancestorLast: [false, false],
      isLast: true,
    });
  });

  it("marks git, in-flight, and focused selection states", () => {
    const rows = buildProjectTreeRows({
      cwd: "/repo",
      paths: ["src/index.ts"],
      expandedPaths: new Set(["src"]),
      cursorPath: "src/index.ts",
      activePath: "src/index.ts",
      inFlightPaths: new Set(["src/index.ts"]),
      gitStatus: new Map([["src/index.ts", "modified"]]),
      focused: false,
    });

    expect(rows.find((row) => row.path === "src/index.ts")).toMatchObject({
      active: true,
      focused: false,
      gitState: "modified",
      inFlight: true,
      selected: true,
    });
  });

  it("keeps directory-only fallback paths expandable", () => {
    const rows = buildProjectTreeRows({
      cwd: "/repo",
      paths: ["src/", "README.md"],
      expandedPaths: new Set(["src"]),
      cursorPath: "src",
      activePath: null,
    });

    expect(rows.map((row) => [row.path, row.kind])).toEqual([
      ["", "root"],
      ["src", "directory"],
      ["README.md", "file"],
    ]);
    expect(rows.find((row) => row.path === "src")).toMatchObject({
      selected: true,
      expanded: true,
      hasChildren: false,
    });
  });

  it("renders an empty workspace as a neutral 'empty' row, not an error row", () => {
    // Cold start in a known (git-tracked) but file-less workspace: gitStatus is
    // present, paths are empty. The fallback row must be a neutral "empty" kind
    // — an empty workspace is a NORMAL first-impression state, not a fault — so
    // it never gets the alarming "!" marker the tree reserves for real errors.
    const rows = buildProjectTreeRows({
      cwd: "/repo",
      paths: [],
      expandedPaths: new Set(),
      cursorPath: null,
      activePath: null,
      gitStatus: new Map(),
    });

    const emptyRow = rows.find((row) => row.id === "loading-empty");
    expect(emptyRow).toMatchObject({
      kind: "empty",
      // Short, column-fitting label. The narrow tree column (truncate-end at
      // ~17-22 cols, depth:1 4-space indent) would chop the old long copy mid-
      // word ("No files yet — de…"); the inviting "describe a task" guidance
      // lives on the welcome card and composer placeholder instead.
      label: "No files yet",
    });
    // Revert-sensitive: restoring kind:"error" / "No project files" fails these.
    expect(emptyRow?.kind).not.toBe("error");
    expect(rows.some((row) => row.kind === "error")).toBe(false);
  });

  it("uses a short empty-state label that fits the narrow tree column without truncating", () => {
    // BUG A regression: the empty-state row sits at depth:1 (4-space indent) in
    // the narrow workspace column, which truncates to ~13-18 chars. The label
    // must be short enough to render whole — never chopped to a dangling em-dash
    // + half-word ("No files yet — de…"). Assert the exact short label.
    const rows = buildProjectTreeRows({
      cwd: "/repo",
      paths: [],
      expandedPaths: new Set(),
      cursorPath: null,
      activePath: null,
      gitStatus: new Map(),
    });

    const emptyRow = rows.find((row) => row.id === "loading-empty");
    expect(emptyRow?.label).toBe("No files yet");
    // Revert-sensitivity: the long string "No files yet — describe a task to get
    // started" is 47 cols and fails this exact-match assertion. The new label is
    // 12 cols, well under the row's render budget (depth:1 indent + truncate at
    // ~17-22 cols), so it never produces the ellipsis glyph from the long copy.
    expect(emptyRow?.label.length).toBeLessThanOrEqual(13);
    expect(emptyRow?.label).not.toContain("…");
    expect(emptyRow?.label).not.toContain("—");
  });

  it("parses git porcelain status", () => {
    const parsed = parseGitStatusPorcelain(
      [
        " M src/changed.ts",
        "A  src/added.ts",
        " D src/deleted.ts",
        "?? src/new.ts",
        "UU src/conflict.ts",
        "R  src/old.ts -> src/new-name.ts",
      ].join("\n"),
    );

    expect(parsed.get("src/changed.ts")).toBe("modified");
    expect(parsed.get("src/added.ts")).toBe("added");
    expect(parsed.get("src/deleted.ts")).toBe("deleted");
    expect(parsed.get("src/new.ts")).toBe("untracked");
    expect(parsed.get("src/conflict.ts")).toBe("unmerged");
    expect(parsed.get("src/new-name.ts")).toBe("renamed");
  });

  it("collects git status for paths that git would quote by default", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-git-status-"));
    const fileName = `${Buffer.from([0xc3, 0xa9]).toString("utf8")}.ts`;

    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await writeFile(join(repo, fileName), "accented\n", "utf8");

      const status = await collectGitStatus(repo);

      expect(status.get(fileName)).toBe("untracked");
      expect([...status.keys()]).not.toContain("\"\\303\\251.ts\"");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("preserves git file paths with leading and trailing spaces", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-git-files-"));
    const leading = " spaced.ts";
    const trailing = "trailing.ts ";

    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await writeFile(join(repo, leading), "leading\n", "utf8");
      await writeFile(join(repo, trailing), "trailing\n", "utf8");

      await expect(listGitFiles(repo)).resolves.toEqual([leading, trailing]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("collects renamed git status for paths containing rename separators", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-git-rename-"));
    const oldPath = "a -> b.ts";
    const newPath = "c -> d.ts";

    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo, stdio: "ignore" });
      await writeFile(join(repo, oldPath), "renamed\n", "utf8");
      execFileSync("git", ["add", oldPath], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["mv", oldPath, newPath], { cwd: repo, stdio: "ignore" });

      const status = await collectGitStatus(repo);

      expect(status.get(newPath)).toBe("renamed");
      expect(status.has("d.ts")).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("does not start filesystem or git refresh work in the constructor", () => {
    const store = new ProjectTreeStore("/repo", 0);

    expect(store.getSnapshot()).toMatchObject({
      loading: true,
      rows: [],
      cursorPath: null,
    });

    store.dispose();
  });

  it("restarts project tree refresh after dispose", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-restart-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await writeFile(join(repo, "first.ts"), "first\n", "utf8");

      store.start();
      await waitForTreePaths(store, ["first.ts"]);

      store.dispose();
      await writeFile(join(repo, "second.ts"), "second\n", "utf8");

      store.start();
      await waitForTreePaths(store, ["first.ts", "second.ts"]);
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("starts one refresh interval and clears it on dispose", () => {
    vi.useFakeTimers();
    const store = new ProjectTreeStore("/repo", 25);
    const refresh = vi.spyOn(store, "refresh").mockResolvedValue(undefined);

    try {
      store.start();
      store.start();

      expect(refresh).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(75);

      expect(refresh).toHaveBeenCalledTimes(4);

      store.dispose();
      vi.advanceTimersByTime(75);

      expect(refresh).toHaveBeenCalledTimes(4);
    } finally {
      store.dispose();
      refresh.mockRestore();
      vi.useRealTimers();
    }
  });

  it("ignores navigation commands before any selectable rows exist", () => {
    const store = new ProjectTreeStore("/repo", 0);
    const snapshots: string[] = [];
    const unsubscribe = store.subscribe(() => {
      snapshots.push(JSON.stringify(store.getSnapshot()));
    });

    try {
      store.move(1);
      store.moveToStart();
      store.moveToEnd();
      store.toggle();
      store.expand();
      store.collapse();
      store.reveal();

      expect(store.getCursorPath()).toBeNull();
      expect(store.getCursorRow()).toBeNull();
      expect(snapshots).toEqual([]);

      store.setActivePath(null);
      expect(store.getSnapshot().activePath).toBeNull();
      expect(snapshots).toHaveLength(1);
    } finally {
      unsubscribe();
      store.dispose();
    }
  });

  it("keeps stale refresh completions from overwriting the latest snapshot", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-stale-refresh-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await writeFile(join(repo, "latest.ts"), "latest\n", "utf8");

      const firstRefresh = store.refresh();
      const secondRefresh = store.refresh();
      await Promise.all([firstRefresh, secondRefresh]);

      expect(store.getSnapshot()).toMatchObject({
        loading: false,
        error: null,
        cursorPath: "latest.ts",
      });
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("reports refresh failures from invalid workspaces and ignores stale failures", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-refresh-error-"));
    const invalidCwd = join(repo, "not-a-directory");
    const store = new ProjectTreeStore(invalidCwd, 0);

    try {
      await writeFile(invalidCwd, "file\n", "utf8");

      const firstRefresh = store.refresh();
      const secondRefresh = store.refresh();
      await Promise.all([firstRefresh, secondRefresh]);

      const snapshot = store.getSnapshot();

      expect(snapshot.loading).toBe(false);
      // The genuine refresh failure is surfaced via snapshot.error (rendered as a
      // dedicated red line), so the fallback tree row stays a neutral "empty"
      // kind — it must NOT carry the "error" kind that paints the alarming "!"
      // marker on a row that, on a normal cold start, just means an empty workspace.
      expect(snapshot.error).toEqual(expect.stringContaining("ENOTDIR"));
      expect(snapshot.rows.find((row) => row.kind === "error")).toBeUndefined();
      expect(snapshot.rows.find((row) => row.kind === "empty")).toMatchObject({
        label: "No files yet",
      });
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("normalizes hidden cursor paths to the nearest visible row", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-store-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await mkdir(join(repo, ".githooks"), { recursive: true });
      await mkdir(join(repo, "docs"), { recursive: true });
      await writeFile(join(repo, ".githooks", "pre-commit"), "#!/bin/sh\n", "utf8");
      await writeFile(join(repo, "docs", "guide.md"), "guide\n", "utf8");
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });

      await store.refresh();

      expect(store.getCursorPath()).toBe(".githooks");
      expect(store.getSnapshot().rows.find((row) => row.path === ".githooks")).toMatchObject({
        selected: true,
      });

      store.move(1);

      expect(store.getCursorPath()).toBe("docs");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("recursively discovers nested source files outside git workspaces", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-nongit-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await mkdir(join(repo, "src", "nested"), { recursive: true });
      await mkdir(join(repo, "node_modules", "ignored"), { recursive: true });
      await writeFile(join(repo, "src", "nested", "index.ts"), "export const value = 1;\n", "utf8");
      await writeFile(join(repo, "node_modules", "ignored", "index.js"), "ignored\n", "utf8");

      await store.refresh();
      store.reveal("src/nested/index.ts");

      const paths = store.getSnapshot().rows.map((row) => row.path);

      expect(paths).toContain("src");
      expect(paths).toContain("src/nested");
      expect(paths).toContain("src/nested/index.ts");
      expect(paths).not.toContain("node_modules");
      expect(paths).not.toContain("node_modules/ignored/index.js");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("normalizes backslash active and attached paths before matching tree rows", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-backslash-state-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await mkdir(join(repo, "src", "nested"), { recursive: true });
      await writeFile(join(repo, "src", "nested", "app.ts"), "app\n", "utf8");

      await store.refresh();
      store.setActivePath("src\\nested\\app.ts");
      store.setAttachedPaths(["src\\nested\\app.ts"]);

      const snapshot = store.getSnapshot();
      const activeRow = snapshot.rows.find((row) => row.path === "src/nested/app.ts");

      expect(snapshot.cursorPath).toBe("src/nested/app.ts");
      expect([...snapshot.expandedPaths].sort()).toEqual(["src", "src/nested"]);
      expect(activeRow).toMatchObject({
        active: true,
        attached: true,
        selected: true,
      });
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("normalizes search-hit and in-flight path sets without emitting unchanged snapshots", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-path-sets-"));
    const store = new ProjectTreeStore(repo, 0);
    const snapshots: string[] = [];
    const unsubscribe = store.subscribe(() => {
      snapshots.push(JSON.stringify(store.getSnapshot()));
    });

    try {
      await mkdir(join(repo, "src", "nested"), { recursive: true });
      await writeFile(join(repo, "src", "nested", "app.ts"), "app\n", "utf8");

      await store.refresh();
      store.reveal("src/nested/app.ts");
      const baselineEmits = snapshots.length;

      store.setSearchHitPaths(["src\\nested\\app.ts"]);
      store.setSearchHitPaths(["src/nested/app.ts"]);
      store.setInFlightPaths(["src\\nested\\missing.ts"]);
      store.setInFlightPaths(["src/nested/app.ts"]);

      const snapshot = store.getSnapshot();
      const row = snapshot.rows.find((item) => item.path === "src/nested/app.ts");

      expect(snapshots).toHaveLength(baselineEmits + 3);
      expect(row).toMatchObject({
        inFlight: true,
        searchHit: true,
      });
    } finally {
      unsubscribe();
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("counts every project file in the WORKSPACE total even when a directory is collapsed", async () => {
    // BUG (undercount): the WORKSPACE header used to count only the currently-
    // VISIBLE tree rows. A collapsed directory hides its children from the rows,
    // so a multi-file subpackage (e.g. an agent-created `converters/`) would read
    // "WORKSPACE 1" while several files actually exist. The snapshot now carries a
    // collapse-independent `fileCount` driven from the real path set.
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-file-count-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await mkdir(join(repo, "converters"), { recursive: true });
      await writeFile(join(repo, "README.md"), "readme\n", "utf8");
      await writeFile(join(repo, "converters", "json.ts"), "json\n", "utf8");
      await writeFile(join(repo, "converters", "yaml.ts"), "yaml\n", "utf8");
      await writeFile(join(repo, "converters", "toml.ts"), "toml\n", "utf8");

      await store.refresh();
      // Leave `converters` collapsed: it is NOT in expandedPaths, so its three
      // files are absent from the visible rows.
      const snapshot = store.getSnapshot();
      expect(snapshot.expandedPaths).not.toContain("converters");

      const visibleFileRows = snapshot.rows.filter((row) => row.kind === "file").length;
      // Only README.md is a visible file row while converters/ stays collapsed.
      expect(visibleFileRows).toBe(1);

      // The header count must reflect the 4 real files (README.md + 3 converters),
      // not the single visible file row. Revert-sensitivity: the old behavior
      // (counting visible file+directory rows) reported 2 here (README.md +
      // converters/), undercounting the four-file project — this assertion fails
      // against that code.
      expect(snapshot.fileCount).toBe(4);
      expect(snapshot.fileCount).toBeGreaterThan(visibleFileRows);
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("auto-expands a directory the agent creates mid-session without disturbing pre-existing collapsed dirs", async () => {
    // UX: when AgenC writes files into a NEW subdirectory during the session, the
    // directory must reveal so the just-written files are visible in the tree —
    // the user should SEE what the agent built without manually expanding. Scope:
    // only directories that newly APPEARED since the baseline scan are revealed,
    // so a pre-existing collapsed directory stays collapsed (no large-repo blowup).
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-auto-expand-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      // Baseline: an existing collapsed directory and a root file. The first scan
      // only records the baseline — it must NOT auto-expand the existing tree.
      await mkdir(join(repo, "existing"), { recursive: true });
      await writeFile(join(repo, "existing", "old.ts"), "old\n", "utf8");
      await writeFile(join(repo, "README.md"), "readme\n", "utf8");

      await store.refresh();
      expect(store.getSnapshot().expandedPaths).not.toContain("existing");

      // The agent creates a brand-new subpackage with files mid-session.
      await mkdir(join(repo, "converters"), { recursive: true });
      await writeFile(join(repo, "converters", "json.ts"), "json\n", "utf8");
      await writeFile(join(repo, "converters", "yaml.ts"), "yaml\n", "utf8");

      await store.refresh();
      const snapshot = store.getSnapshot();
      const rowPaths = snapshot.rows.map((row) => row.path);

      // The newly-created directory is auto-expanded and its new files are visible.
      // Revert-sensitivity: without the auto-expand, `converters` defaults to
      // collapsed, so it is absent from expandedPaths and its two files never
      // appear as rows — these three assertions fail against that code.
      expect(snapshot.expandedPaths).toContain("converters");
      expect(rowPaths).toContain("converters/json.ts");
      expect(rowPaths).toContain("converters/yaml.ts");

      // User-control / scope guard: the pre-existing directory is NOT force-
      // expanded, and its child stays hidden.
      expect(snapshot.expandedPaths).not.toContain("existing");
      expect(rowPaths).not.toContain("existing/old.ts");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("does not re-expand a directory the user collapsed after it was auto-revealed", async () => {
    // Preserve user control: auto-expand is a one-time reveal on a directory's
    // first appearance, not a persistent override. Once the user collapses an
    // agent-created directory, a later refresh must not fight them by re-expanding.
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-auto-expand-respect-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await writeFile(join(repo, "README.md"), "readme\n", "utf8");
      await store.refresh();

      // Agent creates a new directory → auto-revealed.
      await mkdir(join(repo, "pkg"), { recursive: true });
      await writeFile(join(repo, "pkg", "a.ts"), "a\n", "utf8");
      await store.refresh();
      expect(store.getSnapshot().expandedPaths).toContain("pkg");

      // User collapses it.
      store.collapse("pkg");
      expect(store.getSnapshot().expandedPaths).not.toContain("pkg");

      // A later refresh (the directory still exists, just not "new") must respect
      // the collapse. Revert-sensitivity: a force-expand-on-every-refresh design
      // would re-add `pkg` here and fail this assertion.
      await writeFile(join(repo, "pkg", "b.ts"), "b\n", "utf8");
      await store.refresh();
      expect(store.getSnapshot().expandedPaths).not.toContain("pkg");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("navigates, expands, collapses, and reveals project tree rows", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-navigation-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await mkdir(join(repo, "src", "nested"), { recursive: true });
      await writeFile(join(repo, "README.md"), "readme\n", "utf8");
      await writeFile(join(repo, "src", "nested", "app.ts"), "app\n", "utf8");
      await writeFile(join(repo, "src", "other.ts"), "other\n", "utf8");

      await store.refresh();

      expect(store.getCursorPath()).toBe("README.md");
      expect(store.getCursorRow()).toMatchObject({
        kind: "file",
        path: "README.md",
      });

      store.expand("README.md");
      expect(store.getSnapshot().expandedPaths).toEqual([]);

      store.move(-1);
      expect(store.getCursorPath()).toBe("src");

      store.toggle();
      expect(store.getSnapshot().expandedPaths).toContain("src");

      store.collapse("src");
      expect(store.getSnapshot().expandedPaths).not.toContain("src");

      store.collapse("README.md");
      expect(store.getCursorPath()).toBe("src");

      store.toggle();
      expect(store.getSnapshot().expandedPaths).toContain("src");

      store.expand("missing.ts");
      expect(store.getSnapshot().expandedPaths).toContain("src");

      store.move(1);
      expect(store.getCursorPath()).toBe("src/nested");

      store.expand("src/nested");
      store.move(1);
      expect(store.getCursorPath()).toBe("src/nested/app.ts");

      store.collapse("src/nested/app.ts");
      expect(store.getCursorPath()).toBe("src/nested");

      store.reveal("src/nested/app.ts");
      expect(store.getCursorPath()).toBe("src/nested/app.ts");

      store.toggle("src");
      expect(store.getCursorPath()).toBe("src");
      expect(store.getSnapshot().expandedPaths).not.toContain("src");

      store.movePage(1);
      expect(store.getCursorPath()).toBe("README.md");

      store.expand("src");
      store.reveal("src");
      store.setViewportRows(2.9);
      store.movePage(1);
      expect(store.getCursorPath()).toBe("src/nested");

      store.moveToEnd();
      expect(store.getCursorPath()).toBe("README.md");

      store.moveToStart();
      expect(store.getCursorPath()).toBe("src");

      store.setActivePath("src/nested/app.ts");
      store.reveal();
      expect(store.getCursorPath()).toBe("src/nested/app.ts");

      store.toggle("src/nested/app.ts");
      expect(store.getCursorPath()).toBe("src/nested/app.ts");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("keeps ignored-only fallback directories out of non-git workspaces", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-ignored-only-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await mkdir(join(repo, "node_modules", "ignored"), { recursive: true });
      await writeFile(join(repo, "node_modules", "ignored", "index.js"), "ignored\n", "utf8");

      await store.refresh();

      const paths = store.getSnapshot().rows.map((row) => row.path);

      expect(paths).not.toContain("node_modules");
      expect(paths).not.toContain("node_modules/ignored");
      expect(paths).not.toContain("node_modules/ignored/index.js");
      expect(store.getSnapshot()).toMatchObject({
        cursorPath: null,
        error: null,
        loading: false,
      });
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("falls back to top-level paths when gitignore excludes scanner output", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-top-level-fallback-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await writeFile(join(repo, ".gitignore"), "local/\n.gitignore\n", "utf8");
      await mkdir(join(repo, "local"), { recursive: true });

      await store.refresh();

      const paths = store.getSnapshot().rows.map((row) => row.path);

      expect(paths).toContain(".gitignore");
      expect(paths).toContain("local");
      expect(store.getCursorPath()).toBe(".gitignore");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("falls back to the recursive scanner when git has no indexed paths", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-empty-git-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await mkdir(join(repo, "src", "empty"), { recursive: true });
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });

      await store.refresh();
      store.reveal("src/empty");

      const paths = store.getSnapshot().rows.map((row) => row.path);

      expect(paths).toContain("src");
      expect(paths).toContain("src/empty");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("creates a nested file from a workspace-relative path", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-create-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await store.refresh();

      await expect(store.createFile("src/new-file.ts")).resolves.toEqual({ ok: true, path: "src/new-file.ts" });

      expect(await readFile(join(repo, "src", "new-file.ts"), "utf8")).toBe("");
      expect(store.getCursorPath()).toBe("src/new-file.ts");
      expect(store.getSnapshot().rows.map((row) => row.path)).toContain("src/new-file.ts");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("rejects invalid file creation paths before touching disk", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-create-invalid-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await store.refresh();

      await expect(store.createFile("   ")).resolves.toEqual({
        ok: false,
        error: "Enter a workspace-relative path.",
      });
      await expect(store.createFile("src/")).resolves.toEqual({
        ok: false,
        error: "Enter a file path, not a directory path.",
      });
      await expect(store.createFile(".")).resolves.toEqual({
        ok: false,
        error: "Path must stay inside the workspace.",
      });
      await expect(store.createFile("/tmp/outside.ts")).resolves.toEqual({
        ok: false,
        error: "Use a workspace-relative path, not an absolute path.",
      });
      await expect(store.renamePath("../outside.ts", "inside.ts")).resolves.toEqual({
        ok: false,
        error: "Path must stay inside the workspace.",
      });
      await expect(store.renamePath("inside.ts", ".")).resolves.toEqual({
        ok: false,
        error: "Path must stay inside the workspace.",
      });
      await expect(store.deletePath(".")).resolves.toEqual({
        ok: false,
        error: "Path must stay inside the workspace.",
      });

      expect(await readdir(repo)).toEqual([]);
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns stable errors for existing creates and missing renames or deletes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-mutation-errors-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await writeFile(join(repo, "exists.ts"), "exists\n", "utf8");
      await store.refresh();

      await expect(store.createFile("exists.ts")).resolves.toEqual({
        ok: false,
        error: "Cannot create exists.ts: path already exists.",
      });
      await expect(store.renamePath("missing.ts", "renamed.ts")).resolves.toEqual({
        ok: false,
        error: "Cannot rename missing.ts: path does not exist.",
      });
      await expect(store.deletePath("missing.ts")).resolves.toEqual({
        ok: false,
        error: "Cannot delete missing.ts: path does not exist.",
      });
      await expect(store.renamePath("exists.ts", "bad\0target.ts")).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("Cannot rename exists.ts:"),
      });

      expect(await readFile(join(repo, "exists.ts"), "utf8")).toBe("exists\n");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("renames the selected workspace path without overwriting targets", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-rename-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await mkdir(join(repo, "src"), { recursive: true });
      await writeFile(join(repo, "src", "old.ts"), "old\n", "utf8");
      await writeFile(join(repo, "src", "exists.ts"), "exists\n", "utf8");
      await store.refresh();

      await expect(store.renamePath("src/old.ts", "src/exists.ts")).resolves.toMatchObject({
        ok: false,
      });
      await expect(store.renamePath("src/old.ts", "lib/new.ts")).resolves.toEqual({ ok: true, path: "lib/new.ts" });

      await expect(readFile(join(repo, "src", "old.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(repo, "lib", "new.ts"), "utf8")).toBe("old\n");
      expect(store.getCursorPath()).toBe("lib/new.ts");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("preserves leading and trailing spaces in tree mutation paths", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-space-paths-"));
    const store = new ProjectTreeStore(repo, 0);
    const leading = " leading.ts";
    const trailing = "trailing.ts ";
    const renamed = " renamed.ts ";

    try {
      await writeFile(join(repo, leading), "leading\n", "utf8");
      await writeFile(join(repo, trailing), "trailing\n", "utf8");
      await store.refresh();

      await expect(store.renamePath(trailing, renamed)).resolves.toEqual({ ok: true, path: renamed });
      await expect(store.deletePath(leading)).resolves.toEqual({ ok: true, path: leading });

      expect(await readFile(join(repo, renamed), "utf8")).toBe("trailing\n");
      await expect(readFile(join(repo, leading), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(store.getSnapshot().rows.map((row) => row.path)).toContain(renamed);
      expect(store.getSnapshot().rows.map((row) => row.path)).not.toContain(leading);
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns canonical tree paths when renaming to a trailing slash target", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-rename-slash-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await mkdir(join(repo, "src", "nested"), { recursive: true });
      await writeFile(join(repo, "src", "nested", "app.ts"), "app\n", "utf8");
      await store.refresh();

      await expect(store.renamePath("src", "lib/")).resolves.toEqual({
        ok: true,
        path: "lib",
      });

      expect(await readFile(join(repo, "lib", "nested", "app.ts"), "utf8")).toBe("app\n");
      expect(store.getCursorPath()).toBe("lib");
      expect(store.getSnapshot().rows.map((row) => row.path)).toContain("lib");
      expect(store.getSnapshot().rows.map((row) => row.path)).not.toContain("lib/");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("carries expanded directory state across renamed subtrees", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-rename-expanded-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await mkdir(join(repo, "docs"), { recursive: true });
      await mkdir(join(repo, "src", "nested"), { recursive: true });
      await writeFile(join(repo, "docs", "guide.md"), "guide\n", "utf8");
      await writeFile(join(repo, "src", "nested", "app.ts"), "app\n", "utf8");
      await store.refresh();
      store.reveal("docs/guide.md");
      store.reveal("src/nested/app.ts");

      expect([...store.getSnapshot().expandedPaths].sort()).toEqual(["docs", "src", "src/nested"]);

      await expect(store.renamePath("src", "lib")).resolves.toEqual({
        ok: true,
        path: "lib",
      });

      const snapshot = store.getSnapshot();
      const rowPaths = snapshot.rows.map((row) => row.path);

      expect([...snapshot.expandedPaths].sort()).toEqual(["docs", "lib", "lib/nested"]);
      expect(rowPaths).toContain("docs/guide.md");
      expect(rowPaths).toContain("lib/nested/app.ts");
      expect(rowPaths).not.toContain("src");
      expect(snapshot.expandedPaths).not.toContain("src");
      expect(snapshot.expandedPaths).not.toContain("src/nested");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("rejects renaming a directory into its own descendant without mutating it", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-rename-descendant-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await mkdir(join(repo, "src"), { recursive: true });
      await writeFile(join(repo, "src", "app.ts"), "app\n", "utf8");
      await store.refresh();

      const result = await store.renamePath("src", "src/nested/new-src");

      expect(result).toEqual({
        ok: false,
        error: "Cannot rename src to src/nested/new-src: target is inside the source path.",
      });
      expect(await readdir(join(repo, "src"))).toEqual(["app.ts"]);
      expect(await readFile(join(repo, "src", "app.ts"), "utf8")).toBe("app\n");
      expect(store.getSnapshot().rows.map((row) => row.path)).not.toContain("src/nested");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("deletes files and rejects paths outside the workspace", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-delete-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await mkdir(join(repo, "src"), { recursive: true });
      await writeFile(join(repo, "src", "gone.ts"), "gone\n", "utf8");
      await store.refresh();

      await expect(store.createFile("../outside.ts")).resolves.toEqual({
        ok: false,
        error: "Path must stay inside the workspace.",
      });
      await expect(store.deletePath("src/gone.ts")).resolves.toEqual({ ok: true, path: "src/gone.ts" });

      await expect(readFile(join(repo, "src", "gone.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(store.getSnapshot().rows.map((row) => row.path)).not.toContain("src/gone.ts");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("rejects drive-qualified Windows paths for workspace mutations", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-drive-path-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await writeFile(join(repo, "source.ts"), "source\n", "utf8");
      await store.refresh();

      await expect(store.createFile("C:\\Users\\me\\outside.ts")).resolves.toEqual({
        ok: false,
        error: "Use a workspace-relative path, not an absolute path.",
      });
      await expect(store.renamePath("source.ts", "D:/tmp/renamed.ts")).resolves.toEqual({
        ok: false,
        error: "Use a workspace-relative path, not an absolute path.",
      });
      await expect(store.deletePath("E:\\tmp\\gone.ts")).resolves.toEqual({
        ok: false,
        error: "Use a workspace-relative path, not an absolute path.",
      });
      await expect(store.createFile("F:drive-relative.ts")).resolves.toEqual({
        ok: false,
        error: "Use a workspace-relative path, not an absolute path.",
      });

      await expect(readFile(join(repo, "source.ts"), "utf8")).resolves.toBe("source\n");
      await expect(readFile(join(repo, "C:", "Users", "me", "outside.ts"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("prunes expanded directory state when deleting a subtree", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-delete-expanded-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await mkdir(join(repo, "docs"), { recursive: true });
      await mkdir(join(repo, "src", "nested"), { recursive: true });
      await writeFile(join(repo, "docs", "guide.md"), "guide\n", "utf8");
      await writeFile(join(repo, "src", "nested", "app.ts"), "app\n", "utf8");
      await writeFile(join(repo, "README.md"), "readme\n", "utf8");
      await store.refresh();
      store.reveal("docs/guide.md");
      store.reveal("src/nested/app.ts");

      expect([...store.getSnapshot().expandedPaths].sort()).toEqual(["docs", "src", "src/nested"]);

      await expect(store.deletePath("src")).resolves.toEqual({ ok: true, path: "src" });

      const snapshot = store.getSnapshot();

      expect(snapshot.expandedPaths).toEqual(["docs"]);
      expect(snapshot.rows.map((row) => row.path)).toContain("docs/guide.md");
      expect(snapshot.rows.map((row) => row.path)).not.toContain("src");
      expect(snapshot.cursorPath).toBe("docs");
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("clears the cursor when deleting the last selectable workspace path", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-delete-empty-"));
    const store = new ProjectTreeStore(repo, 0);

    try {
      await writeFile(join(repo, "gone.ts"), "gone\n", "utf8");
      await store.refresh();

      expect(store.getCursorPath()).toBe("gone.ts");

      await expect(store.deletePath("gone.ts")).resolves.toEqual({ ok: true, path: "gone.ts" });

      const selectableRows = store.getSnapshot().rows.filter((row) => row.kind === "file" || row.kind === "directory");
      expect(selectableRows).toHaveLength(0);
      expect(store.getCursorPath()).toBeNull();
      expect(store.getSnapshot().cursorPath).toBeNull();
    } finally {
      store.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });
});

async function waitForTreePaths(
  store: ProjectTreeStore,
  expectedPaths: readonly string[],
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const snapshot = store.getSnapshot();
    const paths = snapshot.rows.map((row) => row.path);
    if (!snapshot.loading && expectedPaths.every((path) => paths.includes(path))) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for project tree paths: ${expectedPaths.join(", ")}`);
}

describe("scanWorkspacePaths bounds (workspace-scan OOM regression)", () => {
  // An unbounded scan of a huge cwd (e.g. $HOME) previously ballooned the
  // heap to the V8 limit — the scan must stop at its caps, not enumerate
  // everything.
  it("stops at maxEntries instead of enumerating the whole tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-scan-cap-"));
    try {
      for (let i = 0; i < 60; i++) {
        await writeFile(join(dir, `f${String(i).padStart(3, "0")}.txt`), "x");
      }
      const paths = await scanWorkspacePaths(dir, { maxEntries: 25 });
      expect(paths.length).toBe(25);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not descend past maxDepth", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-scan-depth-"));
    try {
      let deep = dir;
      for (let level = 1; level <= 6; level++) {
        deep = join(deep, `d${level}`);
        await mkdir(deep);
        await writeFile(join(deep, "leaf.txt"), "x");
      }
      const paths = await scanWorkspacePaths(dir, { maxDepth: 3 });
      expect(paths.some((p) => p.includes("d1/d2/d3/"))).toBe(true);
      expect(paths.some((p) => p.includes("d1/d2/d3/d4/"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
