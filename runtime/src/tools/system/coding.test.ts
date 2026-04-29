import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../registry.js";
import { seedSessionReadState } from "./filesystem.js";
import { createCodingTools } from "./coding.js";

function byName(name: string) {
  return (tool: { readonly name: string }) => tool.name === name;
}

async function createRepoFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenc-coding-tools-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "app.ts"),
    [
      "export function greet(name: string): string {",
      "  return `Hello, ${name}`;",
      "}",
      "",
      "export function useGreet(): string {",
      "  return greet(\"world\");",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(root, "README.md"), "# fixture\n", "utf8");
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Tests"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root });
  return root;
}

async function createWorkspaceFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenc-coding-workspace-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "app.ts"),
    [
      "export function greet(name: string): string {",
      "  return `Hello, ${name}`;",
      "}",
      "",
      "export function useGreet(): string {",
      "  return greet(\"world\");",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(root, "README.md"), "# workspace fixture\n", "utf8");
  return root;
}

const createdRoots: string[] = [];

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop()!;
    await import("node:fs/promises").then(({ rm }) =>
      rm(root, { recursive: true, force: true }),
    );
  }
});

describe("createCodingTools", () => {
  it("exposes a searchable coding catalog through system.searchTools", async () => {
    const root = await createRepoFixture();
    createdRoots.push(root);
    const registry = new ToolRegistry();
    const tools = createCodingTools({
      allowedPaths: [root],
      persistenceRootDir: root,
      getToolCatalog: () => registry.listCatalog(),
      codeIntelligenceTools: true,
    });
    registry.registerAll(tools);

    const tool = tools.find(byName("system.searchTools"));
    expect(tool).toBeDefined();

    const raw = await tool!.execute({
      family: "coding",
      __agencAdvertisedToolNames: ["system.gitStatus", "system.searchTools"],
    });
    const parsed = JSON.parse(raw.content) as {
      results: Array<{ name: string; advertised: boolean }>;
    };

    expect(parsed.results.some((entry) => entry.name === "system.gitStatus")).toBe(true);
    expect(parsed.results.some((entry) => entry.name === "system.searchTools")).toBe(true);
  });

  it("returns git summaries, creates worktrees, and resolves semantic symbol lookups", async () => {
    const root = await createRepoFixture();
    createdRoots.push(root);
    const tools = createCodingTools({
      allowedPaths: [root, join(root, "worktrees")],
      persistenceRootDir: root,
      codeIntelligenceTools: true,
    });

    await writeFile(join(root, "README.md"), "# changed\n", "utf8");

    const status = tools.find(byName("system.gitStatus"));
    const branch = tools.find(byName("system.gitBranchInfo"));
    const createWorktree = tools.find(byName("system.gitWorktreeCreate"));
    const worktreeStatus = tools.find(byName("system.gitWorktreeStatus"));
    const symbolSearch = tools.find(byName("system.symbolSearch"));
    const symbolDefinition = tools.find(byName("system.symbolDefinition"));
    const symbolReferences = tools.find(byName("system.symbolReferences"));

    const statusResult = JSON.parse((await status!.execute({ path: root })).content) as {
      summary: { unstaged: string[] };
    };
    expect(statusResult.summary.unstaged).toContain("README.md");

    const branchResult = JSON.parse((await branch!.execute({ path: root })).content) as {
      branch: string | null;
    };
    expect(branchResult.branch).toMatch(/\S+/);

    const worktreePath = resolvePath(root, "worktrees", "feature-copy");
    const createResult = await createWorktree!.execute({
      path: root,
      worktreePath,
      detached: true,
    });
    expect(createResult.isError).not.toBe(true);

    const worktreeState = JSON.parse(
      (await worktreeStatus!.execute({ worktreePath })).content,
    ) as { worktreePath: string; head: string | null };
    expect(worktreeState.worktreePath).toBe(await realpath(worktreePath));
    expect(worktreeState.head).not.toBeNull();

    const searchResult = JSON.parse(
      (await symbolSearch!.execute({ path: root, query: "greet" })).content,
    ) as { symbols: Array<{ name: string; filePath: string }> };
    expect(searchResult.symbols.some((entry) => entry.name === "greet")).toBe(true);

    const definitionResult = JSON.parse(
      (await symbolDefinition!.execute({ path: root, symbol: "greet" })).content,
    ) as { definition: { name: string; filePath: string } };
    expect(definitionResult.definition.name).toBe("greet");
    expect(definitionResult.definition.filePath).toBe("src/app.ts");

    const refsResult = JSON.parse(
      (await symbolReferences!.execute({ path: root, symbol: "greet" })).content,
    ) as { references: Array<{ filePath: string }> };
    expect(refsResult.references.some((entry) => entry.filePath === "src/app.ts")).toBe(true);
  });

  it("supports grep and glob outside git repositories", async () => {
    const root = await createWorkspaceFixture();
    createdRoots.push(root);
    const tools = createCodingTools({
      allowedPaths: [root],
      persistenceRootDir: root,
    });

    const grepTool = tools.find(byName("system.grep"));
    const globTool = tools.find(byName("system.glob"));
    expect(grepTool).toBeDefined();
    expect(globTool).toBeDefined();

    const grepResult = JSON.parse(
      (await grepTool!.execute({ pattern: "Hello", path: root })).content,
    ) as { matches: Array<{ filePath: string; line: number }> };
    expect(grepResult.matches.some((match) => match.filePath === "src/app.ts")).toBe(true);

    const globResult = JSON.parse(
      (await globTool!.execute({ pattern: "**/*.ts", path: root })).content,
    ) as { matches: string[] };
    expect(globResult.matches).toContain("src/app.ts");
  });

  it("keeps grep scoped to the requested subpath", async () => {
    const root = await createRepoFixture();
    createdRoots.push(root);
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "notes.md"), "greet from docs\n", "utf8");

    const tools = createCodingTools({
      allowedPaths: [root],
      persistenceRootDir: root,
    });
    const grepTool = tools.find(byName("system.grep"));
    expect(grepTool).toBeDefined();

    const grepResult = JSON.parse(
      (await grepTool!.execute({ pattern: "docs", path: join(root, "src") })).content,
    ) as { matches: Array<{ filePath: string }> };
    expect(grepResult.matches).toHaveLength(0);
  });

  it("supports additive grep output modes and structured regex failures", async () => {
    const root = await createWorkspaceFixture();
    createdRoots.push(root);
    const tools = createCodingTools({
      allowedPaths: [root],
      persistenceRootDir: root,
    });
    const grepTool = tools.find(byName("system.grep"));
    expect(grepTool).toBeDefined();

    const contentResult = JSON.parse(
      (
        await grepTool!.execute({
          pattern: "return",
          path: root,
          outputMode: "content",
          contextLines: 0,
          headLimit: 1,
        })
      ).content,
    ) as { content: string; outputMode: string };
    expect(contentResult.outputMode).toBe("content");
    expect(contentResult.content).toContain("return");

    const countResult = JSON.parse(
      (
        await grepTool!.execute({
          pattern: "return",
          path: root,
          outputMode: "count",
        })
      ).content,
    ) as { numMatches: number; outputMode: string };
    expect(countResult.outputMode).toBe("count");
    expect(countResult.numMatches).toBeGreaterThan(0);

    const invalidRegexResult = await grepTool!.execute({
      pattern: "(",
      path: root,
      regex: true,
    });
    expect(invalidRegexResult.isError).toBe(true);
    expect(invalidRegexResult.content).toContain("error");
  });

});
