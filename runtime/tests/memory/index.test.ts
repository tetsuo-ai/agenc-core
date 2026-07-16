import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sideQuery } from "../utils/sideQuery.js";
import * as memory from "./index.js";
import {
  findRelevantMemories,
  filterInjectedMemoryFiles,
  formatMemoryManifest,
  formatRelevantMemoryHeader,
  getGlobalMemoryPath,
  processMemoryFile,
  isAutoMemFile,
  isMemoryMention,
  memoryFreshnessNote,
  scanMemoryFiles,
  type MemoryFileInfo,
} from "./index.js";

vi.mock("bun:bundle", () => ({ feature: () => false }));
vi.mock("../utils/hooks.js", () => ({
  executeInstructionsLoadedHooks: async () => undefined,
  hasInstructionsLoadedHook: () => false,
}));
vi.mock("../utils/settings/settings.js", () => ({
  getExecutionAuthoritySettings: () => ({ agencMdExcludes: [] }),
  getInitialSettings: () => ({ agencMdExcludes: [] }),
}));
vi.mock("../tools.js", () => ({}));
vi.mock("src/tools.js", () => ({}));
vi.mock("../utils/model/model.js", () => ({
  getDefaultSonnetModel: () => "sonnet-test",
}));
vi.mock("../utils/sideQuery.js", () => ({
  sideQuery: vi.fn(),
}));

let tempDir = "";

afterEach(async () => {
  vi.useRealTimers();
  vi.mocked(sideQuery).mockReset();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("memory public access surface", () => {
  it("exports the MM-07 public access contract", () => {
    for (const name of [
      "clearMemoryFileCaches",
      "checkTeamMemSecrets",
      "detectSessionFileType",
      "detectSessionPatternType",
      "filterInjectedMemoryFiles",
      "findRelevantMemories",
      "formatMemoryManifest",
      "formatRelevantMemoryHeader",
      "getAgenCMds",
      "getAllMemoryFilePaths",
      "getAutoMemPath",
      "getConditionalRulesForCwdLevelDirectory",
      "getExternalAgenCMdIncludes",
      "getGlobalMemoryPath",
      "getLargeMemoryFiles",
      "getSecretLabel",
      "getManagedAndUserConditionalRules",
      "getMemoryFiles",
      "getMemoryFilesForNestedDirectory",
      "getProjectMemoryPathForSelector",
      "hasExternalAgenCMdIncludes",
      "isAutoMemFile",
      "isMemoryFilePath",
      "isMemoryMention",
      "memoryFreshnessNote",
      "processConditionedMdRules",
      "processMdRules",
      "processMemoryFile",
      "redactSecrets",
      "resetGetMemoryFilesCache",
      "scanMemoryFiles",
      "scanForSecrets",
      "shouldShowAgenCMdExternalIncludesWarning",
      "stripHtmlComments",
    ]) {
      expect(memory, name).toHaveProperty(name);
      expect(memory[name as keyof typeof memory], name).toBeTypeOf("function");
    }

    expect(memory.MAX_MEMORY_CHARACTER_COUNT).toBe(40000);
    expect(memory.MEMORY_MENTION_SYNTAX).toBe("@memory");
    expect(memory.MEMORY_MENTION_ALIASES).toEqual(["@memory", "@memories"]);

    expect(findRelevantMemories).toBeTypeOf("function");
    expect(getGlobalMemoryPath).toBeTypeOf("function");
    expect(filterInjectedMemoryFiles).toBeTypeOf("function");
    expect(isAutoMemFile).toBeTypeOf("function");
    expect(isMemoryMention("@memory")).toBe(true);
    expect(memoryFreshnessNote).toBeTypeOf("function");
  });

  it("keeps injected memory filtering equivalent to the canonical loader helper", async () => {
    const files: MemoryFileInfo[] = [
      { path: "/memory/project.md", type: "Project", content: "project" },
      { path: "/memory/auto.md", type: "AutoMem", content: "auto" },
      { path: "/memory/team.md", type: "TeamMem", content: "team" },
    ];

    // The MEMORY.md-index skip is inlined off in the open build, so the public
    // surface always returns every memory file untouched, matching the
    // canonical loader helper exactly.
    const canonical = await import("./agencmd.js");

    expect(filterInjectedMemoryFiles(files)).toBe(files);
    expect(filterInjectedMemoryFiles(files)).toEqual(
      canonical.filterInjectedMemoryFiles(files),
    );
  });

  it("selects relevant memories through the public recall surface", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-index-"));
    const targetPath = join(tempDir, "target.md");
    const surfacedPath = join(tempDir, "already.md");

    await writeFile(
      targetPath,
      [
        "---",
        "description: Browser automation guidance",
        "type: usage",
        "---",
        "",
        "Use the browser automation workflow.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      surfacedPath,
      [
        "---",
        "description: Previously surfaced memory",
        "type: feedback",
        "---",
        "",
        "This memory already appeared in context.",
      ].join("\n"),
      "utf8",
    );

    vi.mocked(sideQuery).mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            selected_memories: ["target.md", "already.md", "missing.md"],
          }),
        },
      ],
    } as never);

    const result = await findRelevantMemories(
      "use browser automation",
      tempDir,
      new AbortController().signal,
      ["mcp__browser__open"],
      new Set([surfacedPath]),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe(targetPath);
    expect(result[0]?.mtimeMs).toBeTypeOf("number");

    const options = vi.mocked(sideQuery).mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
      querySource: string;
    };
    expect(options.querySource).toBe("memdir_relevance");
    expect(options.messages[0]?.content).toContain("target.md");
    expect(options.messages[0]?.content).toContain(
      "Recently used tools: mcp__browser__open",
    );
    expect(options.messages[0]?.content).not.toContain("already.md");
  });

  it("loads instruction memory files through the public surface", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-index-"));
    const instructionPath = join(tempDir, "AGENC.md");
    await writeFile(
      instructionPath,
      [
        "---",
        "paths: src/**",
        "---",
        "",
        "Use the repository testing policy.",
      ].join("\n"),
      "utf8",
    );

    const files = await processMemoryFile(
      instructionPath,
      "Project",
      new Set<string>(),
      false,
      0,
      undefined,
      tempDir,
    );

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe(instructionPath);
    expect(files[0]?.type).toBe("Project");
    expect(files[0]?.content).toContain("Use the repository testing policy.");
    expect(files[0]?.globs).toEqual(["src"]);
  });

  it("scans and formats manifests through the public surface", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-index-"));
    await writeFile(
      join(tempDir, "feedback.md"),
      [
        "---",
        "description: Use terse responses",
        "type: feedback",
        "---",
        "",
        "The user prefers terse responses.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(tempDir, "MEMORY.md"), "# index\n", "utf8");

    const manifest = formatMemoryManifest(await scanMemoryFiles(tempDir));

    expect(manifest).toContain("[feedback] feedback.md");
    expect(manifest).toContain("Use terse responses");
    expect(manifest).not.toContain("MEMORY.md");
  });

  it("formats stable relevant-memory headers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T12:00:00.000Z"));

    expect(
      formatRelevantMemoryHeader("/memory/fresh.md", Date.now()),
    ).toBe("Memory (saved today): /memory/fresh.md:");

    const stale = formatRelevantMemoryHeader(
      "/memory/stale.md",
      Date.now() - 3 * 86_400_000,
    );

    expect(stale).toContain("This memory is 3 days old.");
    expect(stale).toContain("Memory: /memory/stale.md:");
  });
});
