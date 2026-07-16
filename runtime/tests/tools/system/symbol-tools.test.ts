/**
 * Tests for `createSymbolTools` (src/tools/system/symbol-tools.ts) — the
 * tool-layer wrappers around CodeIntelManager. Workspaces are real git
 * repos because `resolveRepoRoot` shells out to `git rev-parse
 * --show-toplevel`.
 *
 * Coverage:
 *  - schema/identity for the three returned tools.
 *  - symbolSearch: happy path with repo-relative filePath rewriting,
 *    language/kind filtering.
 *  - symbolDefinition: empty-symbol error, unknown-symbol error, known
 *    symbol with relative filePath, filePath restriction.
 *  - symbolReferences: reference shape with relative filePath.
 *  - repo-root rejection for a path outside allowedPaths.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSymbolTools } from "./symbol-tools.js";
import type { Tool } from "../../../src/tools/types.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";

const execFileP = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileP("git", args, { cwd });
}

async function setupRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenc-symbol-tools-"));
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(
    join(root, "lib.ts"),
    "export function widget() {\n  return useWidget();\n}\n",
    "utf8",
  );
  await writeFile(
    join(root, "use.ts"),
    "import { widget } from './lib';\nexport const w = widget();\n",
    "utf8",
  );
  await git(root, "add", ".");
  await git(root, "commit", "-m", "init");
  return root;
}

function toolByName(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return bindExplicitDangerBoundary(tool);
}

describe("createSymbolTools", () => {
  let root: string;
  let persistenceRoot: string;
  let tools: readonly Tool[];

  beforeEach(async () => {
    root = await setupRepo();
    persistenceRoot = await mkdtemp(join(tmpdir(), "agenc-symbol-tools-persist-"));
    tools = createSymbolTools({
      allowedPaths: [root],
      persistenceRootDir: persistenceRoot,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(persistenceRoot, { recursive: true, force: true });
  });

  it("returns three named tools with required fields", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      "system.symbolDefinition",
      "system.symbolReferences",
      "system.symbolSearch",
    ]);
    expect(toolByName(tools, "system.symbolDefinition").inputSchema.required).toEqual([
      "symbol",
    ]);
    expect(toolByName(tools, "system.symbolReferences").inputSchema.required).toEqual([
      "symbol",
    ]);
  });

  describe("system.symbolSearch", () => {
    it("returns repo-relative symbol paths", async () => {
      const tool = toolByName(tools, "system.symbolSearch");
      const result = await tool.execute({ path: root, query: "widget" });
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content);
      expect(payload.repoRoot).toBe(root);
      expect(payload.symbols.length).toBeGreaterThanOrEqual(1);
      for (const symbol of payload.symbols) {
        expect(isAbsolute(symbol.filePath)).toBe(false);
      }
      expect(payload.symbols.some((s: { name: string }) => s.name === "widget")).toBe(
        true,
      );
    });

    it("flows kind filtering through to the index", async () => {
      const tool = toolByName(tools, "system.symbolSearch");
      const result = await tool.execute({ path: root, kind: "variable" });
      const payload = JSON.parse(result.content);
      for (const symbol of payload.symbols) {
        expect(symbol.kind).toBe("variable");
      }
    });
  });

  describe("system.symbolDefinition", () => {
    it("errors on an empty symbol", async () => {
      const tool = toolByName(tools, "system.symbolDefinition");
      const result = await tool.execute({ path: root, symbol: "   " });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain("non-empty string");
    });

    it("errors on an unknown symbol", async () => {
      const tool = toolByName(tools, "system.symbolDefinition");
      const result = await tool.execute({ path: root, symbol: "doesNotExist" });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain("No definition found");
    });

    it("returns a relative-path definition for a known symbol", async () => {
      const tool = toolByName(tools, "system.symbolDefinition");
      const result = await tool.execute({ path: root, symbol: "widget" });
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content);
      expect(payload.definition.name).toBe("widget");
      expect(payload.definition.filePath).toBe("lib.ts");
    });

    it("restricts the match with a filePath argument", async () => {
      const tool = toolByName(tools, "system.symbolDefinition");
      const result = await tool.execute({
        path: root,
        symbol: "widget",
        filePath: "use.ts",
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain("No definition found");
    });
  });

  describe("system.symbolReferences", () => {
    it("returns references with relative paths", async () => {
      const tool = toolByName(tools, "system.symbolReferences");
      const result = await tool.execute({ path: root, symbol: "widget" });
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content);
      expect(payload.symbol).toBe("widget");
      expect(payload.references.length).toBeGreaterThanOrEqual(1);
      for (const ref of payload.references) {
        expect(isAbsolute(ref.filePath)).toBe(false);
        expect(typeof ref.line).toBe("number");
        expect(typeof ref.lineText).toBe("string");
      }
    });
  });

  it("rejects a path outside allowedPaths", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agenc-symbol-tools-outside-"));
    try {
      const tool = toolByName(tools, "system.symbolSearch");
      const result = await tool.execute({ path: outside, query: "x" });
      expect(result.isError).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
