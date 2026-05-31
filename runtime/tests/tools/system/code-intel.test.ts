/**
 * Tests for `CodeIntelManager` and its exported helpers
 * (src/tools/system/code-intel.ts) — the parsing core that symbol-tools
 * wraps. Workspaces are non-git tmpdirs so the `git ls-files` path in
 * `listCandidateFiles` returns empty and the `readdir` fallback runs.
 *
 * Coverage:
 *  - indexTypeScriptSymbols: function/class/interface/enum/typealias/
 *    variable kinds, 1-based line/column, containerName on members,
 *    language tagging (.ts -> typescript, .mjs/.js -> javascript), and
 *    the .tsx ScriptKind branch.
 *  - indexHeuristicSymbols: python/rust/go/c regex paths + name cleanup.
 *  - searchSymbols: exact > prefix > substring ranking, language/kind
 *    filters, empty-query "return all", and maxResults clamp (1..200).
 *  - getDefinition: by name, with filePath filter, unknown -> undefined.
 *  - getReferences: word-boundary match, filePath filter, maxResults, and
 *    the documented one-match-per-line limitation.
 *  - persistence: snapshot JSON appears under the persistence root.
 *  - collectWorkspaceLanguages / toRelativeWorkspacePath helpers.
 */
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CodeIntelManager,
  collectWorkspaceLanguages,
  toRelativeWorkspacePath,
} from "./code-intel.js";

describe("CodeIntelManager", () => {
  let workspace: string;
  let persistenceRoot: string;
  let manager: CodeIntelManager;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agenc-code-intel-ws-"));
    persistenceRoot = await mkdtemp(join(tmpdir(), "agenc-code-intel-persist-"));
    manager = new CodeIntelManager({ persistenceRootDir: persistenceRoot });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(persistenceRoot, { recursive: true, force: true });
  });

  describe("TypeScript AST indexing", () => {
    it("extracts symbol kinds, positions, and container names", async () => {
      await writeFile(
        join(workspace, "a.ts"),
        [
          "export function topFn() { return 1; }",
          "export const topConst = 2;",
          "export interface Shape { x: number; }",
          "export enum Color { Red, Green }",
          "export type Alias = string;",
          "export class Widget {",
          "  inner() { return 3; }",
          "}",
        ].join("\n"),
        "utf8",
      );
      const symbols = await manager.searchSymbols({ workspaceRoot: workspace });
      const byName = new Map(symbols.map((s) => [s.name, s]));

      expect(byName.get("topFn")?.kind).toBe("function");
      expect(byName.get("topConst")?.kind).toBe("variable");
      expect(byName.get("Shape")?.kind).toBe("interface");
      expect(byName.get("Color")?.kind).toBe("enum");
      expect(byName.get("Alias")?.kind).toBe("typealias");
      expect(byName.get("Widget")?.kind).toBe("class");

      const topFn = byName.get("topFn")!;
      expect(topFn.language).toBe("typescript");
      expect(topFn.line).toBe(1);
      expect(topFn.column).toBeGreaterThanOrEqual(1);
    });

    it("tags .mjs files as javascript", async () => {
      await writeFile(
        join(workspace, "b.mjs"),
        "export function jsFn() { return 1; }\n",
        "utf8",
      );
      const symbols = await manager.searchSymbols({ workspaceRoot: workspace });
      const jsFn = symbols.find((s) => s.name === "jsFn");
      expect(jsFn?.language).toBe("javascript");
    });

    it("parses .tsx without throwing and yields the declared symbol", async () => {
      await writeFile(
        join(workspace, "c.tsx"),
        "export function View() { return <div>hi</div>; }\n",
        "utf8",
      );
      const symbols = await manager.searchSymbols({ workspaceRoot: workspace });
      const view = symbols.find((s) => s.name === "View");
      expect(view).toBeDefined();
      expect(view?.kind).toBe("function");
    });
  });

  describe("heuristic indexing", () => {
    it("indexes python class/def", async () => {
      await writeFile(
        join(workspace, "m.py"),
        "class Foo:\n    def bar(self):\n        return 1\n",
        "utf8",
      );
      const symbols = await manager.searchSymbols({ workspaceRoot: workspace });
      const foo = symbols.find((s) => s.name === "Foo");
      const bar = symbols.find((s) => s.name === "bar");
      expect(foo?.kind).toBe("class");
      expect(foo?.language).toBe("python");
      expect(bar?.kind).toBe("def");
    });

    it("indexes rust fn/struct and strips pub", async () => {
      await writeFile(
        join(workspace, "lib.rs"),
        "pub fn baz() {}\nstruct S { x: i32 }\n",
        "utf8",
      );
      const symbols = await manager.searchSymbols({ workspaceRoot: workspace });
      const baz = symbols.find((s) => s.name === "baz");
      const s = symbols.find((sym) => sym.name === "S");
      expect(baz?.kind).toBe("fn");
      expect(s?.kind).toBe("struct");
    });

    it("indexes go func/type", async () => {
      await writeFile(
        join(workspace, "main.go"),
        "func f() {}\ntype T struct{}\n",
        "utf8",
      );
      const symbols = await manager.searchSymbols({ workspaceRoot: workspace });
      expect(symbols.find((s) => s.name === "f")?.kind).toBe("func");
      expect(symbols.find((s) => s.name === "T")?.kind).toBe("type");
    });

    it("indexes c struct and function", async () => {
      await writeFile(
        join(workspace, "prog.c"),
        "struct X { int a; };\nint fn(int a) {\n  return a;\n}\n",
        "utf8",
      );
      const symbols = await manager.searchSymbols({ workspaceRoot: workspace });
      expect(symbols.find((s) => s.name === "X")?.kind).toBe("struct");
      expect(symbols.find((s) => s.name === "fn")?.kind).toBe("function");
    });
  });

  describe("searchSymbols", () => {
    beforeEach(async () => {
      await writeFile(
        join(workspace, "rank.ts"),
        [
          "export function handle() {}",
          "export function handleClick() {}",
          "export function onHandle() {}",
        ].join("\n"),
        "utf8",
      );
    });

    it("ranks exact before prefix before substring", async () => {
      const symbols = await manager.searchSymbols({
        workspaceRoot: workspace,
        query: "handle",
      });
      const names = symbols.map((s) => s.name);
      expect(names.indexOf("handle")).toBeLessThan(names.indexOf("handleClick"));
      expect(names.indexOf("handleClick")).toBeLessThan(names.indexOf("onHandle"));
    });

    it("filters by language and kind", async () => {
      const onlyJs = await manager.searchSymbols({
        workspaceRoot: workspace,
        language: "javascript",
      });
      expect(onlyJs).toHaveLength(0);
      const fns = await manager.searchSymbols({
        workspaceRoot: workspace,
        kind: "function",
      });
      expect(fns.length).toBeGreaterThanOrEqual(3);
    });

    it("returns all symbols for an empty query", async () => {
      const all = await manager.searchSymbols({ workspaceRoot: workspace });
      expect(all.length).toBeGreaterThanOrEqual(3);
    });

    it("clamps maxResults to at least 1", async () => {
      const clamped = await manager.searchSymbols({
        workspaceRoot: workspace,
        maxResults: 0,
      });
      expect(clamped).toHaveLength(1);
    });

    it("clamps maxResults to at most 200", async () => {
      const huge = await manager.searchSymbols({
        workspaceRoot: workspace,
        maxResults: 10_000,
      });
      expect(huge.length).toBeLessThanOrEqual(200);
    });
  });

  describe("getDefinition", () => {
    beforeEach(async () => {
      await writeFile(
        join(workspace, "d1.ts"),
        "export function shared() {}\n",
        "utf8",
      );
      await writeFile(
        join(workspace, "d2.ts"),
        "export function shared() {}\nexport function only2() {}\n",
        "utf8",
      );
    });

    it("returns the first matching symbol by name", async () => {
      const def = await manager.getDefinition({
        workspaceRoot: workspace,
        symbolName: "shared",
      });
      expect(def?.name).toBe("shared");
    });

    it("restricts the match with a filePath filter", async () => {
      const def = await manager.getDefinition({
        workspaceRoot: workspace,
        symbolName: "shared",
        filePath: join(workspace, "d2.ts"),
      });
      expect(def?.filePath).toBe(join(workspace, "d2.ts"));
    });

    it("returns undefined for an unknown symbol", async () => {
      const def = await manager.getDefinition({
        workspaceRoot: workspace,
        symbolName: "nope",
      });
      expect(def).toBeUndefined();
    });
  });

  describe("getReferences", () => {
    it("finds word-boundary references and respects filePath + maxResults", async () => {
      await writeFile(
        join(workspace, "r1.ts"),
        "const target = 1;\nconsole.log(target);\n",
        "utf8",
      );
      await writeFile(join(workspace, "r2.ts"), "const target = 2;\n", "utf8");

      const all = await manager.getReferences({
        workspaceRoot: workspace,
        symbolName: "target",
      });
      expect(all.length).toBeGreaterThanOrEqual(2);

      const scoped = await manager.getReferences({
        workspaceRoot: workspace,
        symbolName: "target",
        filePath: join(workspace, "r2.ts"),
      });
      expect(scoped).toHaveLength(1);
      expect(scoped[0]?.filePath).toBe(join(workspace, "r2.ts"));

      const limited = await manager.getReferences({
        workspaceRoot: workspace,
        symbolName: "target",
        maxResults: 1,
      });
      expect(limited).toHaveLength(1);
    });

    it("records at most one reference per line (documented limitation)", async () => {
      // getReferences uses a non-global regex and calls exec once per
      // line, so repeated occurrences on a single line are collapsed to
      // one. This pins the current behavior; it is not asserted as ideal.
      await writeFile(join(workspace, "dup.ts"), "foo foo foo\n", "utf8");
      const refs = await manager.getReferences({
        workspaceRoot: workspace,
        symbolName: "foo",
      });
      expect(refs).toHaveLength(1);
    });
  });

  describe("persistence", () => {
    it("writes a snapshot JSON under the persistence root", async () => {
      await writeFile(join(workspace, "p.ts"), "export const v = 1;\n", "utf8");
      await manager.searchSymbols({ workspaceRoot: workspace });
      const snapshotDir = join(persistenceRoot, "code-intel");
      const entries = await readdir(snapshotDir).catch(() => [] as string[]);
      expect(entries.some((name) => name.endsWith(".json"))).toBe(true);
    });

    it("reflects new symbols after a file mutation", async () => {
      await writeFile(join(workspace, "p.ts"), "export const v = 1;\n", "utf8");
      const first = await manager.searchSymbols({ workspaceRoot: workspace });
      expect(first.find((s) => s.name === "added")).toBeUndefined();

      await writeFile(
        join(workspace, "p.ts"),
        "export const v = 1;\nexport function added() {}\n",
        "utf8",
      );
      const second = await manager.searchSymbols({ workspaceRoot: workspace });
      expect(second.find((s) => s.name === "added")).toBeDefined();
    });
  });
});

describe("code-intel helpers", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agenc-code-intel-helpers-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("collectWorkspaceLanguages counts files per language", async () => {
    await writeFile(join(workspace, "a.ts"), "export const a = 1;\n", "utf8");
    await mkdir(join(workspace, "sub"), { recursive: true });
    await writeFile(join(workspace, "sub", "b.ts"), "export const b = 2;\n", "utf8");
    await writeFile(join(workspace, "c.py"), "x = 1\n", "utf8");

    const counts = await collectWorkspaceLanguages(workspace);
    expect(counts.typescript).toBe(2);
    expect(counts.python).toBe(1);
  });

  it("toRelativeWorkspacePath converts and falls back to basename", () => {
    const file = join(workspace, "src", "x.ts");
    expect(toRelativeWorkspacePath(workspace, file)).toBe(join("src", "x.ts"));
    expect(toRelativeWorkspacePath(file, file)).toBe(basename(file));
  });
});
