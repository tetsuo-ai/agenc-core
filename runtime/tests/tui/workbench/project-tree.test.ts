import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildProjectTreeRows } from "../../../src/tui/workbench/project-tree/buildTree.js";
import { parseGitStatusPorcelain } from "../../../src/tui/workbench/project-tree/gitStatus.js";
import { ProjectTreeStore } from "../../../src/tui/workbench/project-tree/ProjectTreeStore.js";

describe("project tree helpers", () => {
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

  it("does not start filesystem or git refresh work in the constructor", () => {
    const store = new ProjectTreeStore("/repo", 0);

    expect(store.getSnapshot()).toMatchObject({
      loading: true,
      rows: [],
      cursorPath: null,
    });

    store.dispose();
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
});
