import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../registry.js";
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

  it("supports readFileRange followed by applyPatch under read-before-write rules", async () => {
    const root = await createRepoFixture();
    createdRoots.push(root);
    const tools = createCodingTools({
      allowedPaths: [root],
      persistenceRootDir: root,
    });

    const readRange = tools.find(byName("system.readFileRange"));
    const applyPatch = tools.find(byName("system.applyPatch"));
    expect(readRange).toBeDefined();
    expect(applyPatch).toBeDefined();

    const before = await readRange!.execute({
      path: join(root, "src", "app.ts"),
      startLine: 1,
      endLine: 4,
      __agencSessionId: "session-1",
    });
    expect(before.isError).not.toBe(true);

    const patch = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,3 @@",
      " export function greet(name: string): string {",
      "-  return `Hello, ${name}`;",
      "+  return `Hi, ${name}`;",
      " }",
      "",
    ].join("\n");

    const result = await applyPatch!.execute({
      path: root,
      patch,
      __agencSessionId: "session-1",
    });
    expect(result.isError).not.toBe(true);

    const next = await readFile(join(root, "src", "app.ts"), "utf8");
    expect(next).toContain("return `Hi, ${name}`;");
  });

  it("returns git summaries, creates worktrees, and resolves semantic symbol lookups", async () => {
    const root = await createRepoFixture();
    createdRoots.push(root);
    const tools = createCodingTools({
      allowedPaths: [root, join(root, "worktrees")],
      persistenceRootDir: root,
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
    expect(worktreeState.worktreePath).toBe(worktreePath);
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
});
