import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = existsSync(resolve(process.cwd(), "runtime/src"))
  ? resolve(process.cwd())
  : resolve(process.cwd(), "..");

describe("memory wiring contract", () => {
  it("removes the replaced custom memory files", () => {
    for (const rel of [
      "runtime/src/commands/memory.ts",
      "runtime/src/bin/memory-bootstrap.ts",
      "runtime/src/prompts/attachments/relevant-memory.ts",
      "runtime/src/prompts/memory/index.ts",
      "runtime/src/prompts/memory/loader.ts",
      "runtime/src/prompts/memory/types.ts",
    ]) {
      expect(existsSync(resolve(root, rel)), rel).toBe(false);
    }
  });

  it("does not import the replaced memory module paths", () => {
    const registry = readFileSync(resolve(root, "runtime/src/commands/registry.ts"), "utf8");
    const bootstrap = readFileSync(resolve(root, "runtime/src/bin/bootstrap.ts"), "utf8");
    const agenc = readFileSync(resolve(root, "runtime/src/bin/agenc.ts"), "utf8");
    expect(registry).not.toContain("./memory.js");
    expect(bootstrap).not.toContain("../prompts/memory/index.js");
    expect(bootstrap).not.toContain("./memory-bootstrap.js");
    expect(agenc).not.toContain("../prompts/memory/index.js");
  });

  it("routes MM-01 memory imports through runtime/src/memory", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(resolve(root, "runtime/src"))) {
      const rel = file.slice(root.length + 1);
      if (
        rel.startsWith("runtime/src/agenc/upstream/") ||
        rel === "runtime/src/memdir/teamMemPaths.ts" ||
        rel === "runtime/src/memdir/teamMemPrompts.ts"
      ) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      const oldOwnedImport =
        /from ["'][^"']*(?:memdir\/(?:memdir|paths|memoryAge|memoryScan|memoryTypes|findRelevantMemories)|utils\/(?:agencmd|memoryFileDetection))/.test(
          source,
        ) ||
        /import\(["'][^"']*(?:memdir\/(?:memdir|paths|memoryAge|memoryScan|memoryTypes|findRelevantMemories)|utils\/(?:agencmd|memoryFileDetection))/.test(
          source,
        );
      if (oldOwnedImport) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("wires global durable memory into loading, recall, and permissions", () => {
    const agencmd = readFileSync(resolve(root, "runtime/src/memory/agencmd.ts"), "utf8");
    const projectMemory = readFileSync(resolve(root, "runtime/src/memory/project-memory.ts"), "utf8");
    const fileReadTool = readFileSync(resolve(root, "runtime/src/tools/FileReadTool/FileReadTool.ts"), "utf8");
    const attachments = readFileSync(resolve(root, "runtime/src/utils/attachments.ts"), "utf8");
    const filesystem = readFileSync(resolve(root, "runtime/src/utils/permissions/filesystem.ts"), "utf8");

    expect(agencmd).toContain("getGlobalMemoryEntrypoint");
    expect(agencmd).toContain("globalMemEntry");
    expect(projectMemory).toContain("getProjectMemoryPathForSelector");
    expect(projectMemory).toContain("MEMORY_MENTION_SYNTAX");
    expect(fileReadTool).toContain("detectSessionFileType");
    expect(fileReadTool).toContain("../../memory/project-memory.js");
    expect(fileReadTool).not.toContain("function detectSessionFileType");
    expect(attachments).toContain("getDurableMemorySearchDirs");
    expect(attachments).toContain("getGlobalMemoryPath");
    expect(filesystem).toContain("isGlobalMemoryPath");
  });
});

function listSourceFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      result.push(full);
    }
  }
  return result;
}
