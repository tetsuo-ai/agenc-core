import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { LLMMessage } from "../../llm/types.js";
import {
  clearFileReadListenersForTests,
  createFileReadTool,
} from "../../tools/system/index.js";
import { SESSION_ID_ARG } from "../../tools/system/filesystem.js";
import {
  createMagicDocsEditPolicy,
  detectMagicDocHeader,
  initMagicDocs,
  registerMagicDoc,
  resetMagicDocsForTests,
  runMagicDocsPostSamplingHook,
  setMagicDocsAgentRunnerForTests,
  trackedMagicDocPathsForTests,
  type MagicDocsAgentRequest,
} from "./magicDocs.js";
import {
  buildMagicDocsUpdatePrompt,
  substituteMagicDocsVariables,
} from "./prompts.js";

let tempRoot: string;
let previousAgencHome: string | undefined;
let previousAgencConfigDir: string | undefined;

const idleMessages: LLMMessage[] = [
  { role: "user", content: "What changed?" },
  { role: "assistant", content: "The architecture changed." },
];

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "agenc-magic-docs-"));
  previousAgencHome = process.env.AGENC_HOME;
  previousAgencConfigDir = process.env.AGENC_CONFIG_DIR;
  process.env.AGENC_HOME = tempRoot;
  delete process.env.AGENC_CONFIG_DIR;
  clearFileReadListenersForTests();
  resetMagicDocsForTests();
});

afterEach(async () => {
  resetMagicDocsForTests();
  clearFileReadListenersForTests();
  if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousAgencHome;
  if (previousAgencConfigDir === undefined) delete process.env.AGENC_CONFIG_DIR;
  else process.env.AGENC_CONFIG_DIR = previousAgencConfigDir;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("MagicDocs", () => {
  it("detects a Magic Doc header and optional italicized instructions", () => {
    expect(
      detectMagicDocHeader(
        "# MAGIC DOC: Runtime Map\n\n_Keep this focused on entry points._\n\nBody",
      ),
    ).toEqual({
      title: "Runtime Map",
      instructions: "Keep this focused on entry points.",
    });

    expect(detectMagicDocHeader("# Not magic\n\nBody")).toBeNull();
  });

  it("substitutes prompt variables in one pass", () => {
    const prompt = substituteMagicDocsVariables(
      "{{docTitle}} {{missing}} {{docContents}}",
      {
        docTitle: "Title",
        docContents: "Literal {{docTitle}}",
      },
    );

    expect(prompt).toBe("Title {{missing}} Literal {{docTitle}}");
  });

  it("loads a custom AgenC prompt template from config home", async () => {
    const promptDir = join(tempRoot, "magic-docs");
    await mkdir(promptDir, { recursive: true });
    await writeFile(
      join(promptDir, "prompt.md"),
      "Path={{docPath}}\nTitle={{docTitle}}\n{{customInstructions}}",
      "utf8",
    );

    await expect(
      buildMagicDocsUpdatePrompt("body", "/tmp/doc.md", "Architecture", "Be terse"),
    ).resolves.toContain("Path=/tmp/doc.md\nTitle=Architecture");
  });

  it("registers tagged markdown files when FileRead succeeds", async () => {
    const docPath = join(tempRoot, "notes.md");
    await writeFile(docPath, "# MAGIC DOC: Notes\n\nBody\n", "utf8");
    initMagicDocs();

    const tool = createFileReadTool({ allowedPaths: [tempRoot] });
    const result = await tool.execute({
      file_path: docPath,
      [SESSION_ID_ARG]: "session-1",
    });

    expect(result.isError).not.toBe(true);
    expect(trackedMagicDocPathsForTests()).toEqual([docPath]);
  });

  it("runs idle post-sampling updates with cloned read-file state", async () => {
    const docPath = join(tempRoot, "architecture.md");
    await writeFile(
      docPath,
      "# MAGIC DOC: Architecture\n\n_Keep only current design._\n\nOld body\n",
      "utf8",
    );
    registerMagicDoc(docPath);
    const parentReadFileState = new Map<string, unknown>([
      [docPath, { stale: true }],
      ["/keep.md", { keep: true }],
    ]);
    let captured: MagicDocsAgentRequest | null = null;
    setMagicDocsAgentRunnerForTests(async (request) => {
      captured = request;
      request.readFileState.set("/mutated.md", true);
    });

    await runMagicDocsPostSamplingHook({
      messages: idleMessages,
      querySource: "repl_main_thread",
      readFileState: parentReadFileState,
    });

    expect(captured?.docPath).toBe(docPath);
    expect(captured?.title).toBe("Architecture");
    expect(captured?.instructions).toBe("Keep only current design.");
    expect(captured?.prompt).toContain("Old body");
    expect(captured?.readFileState.has(docPath)).toBe(false);
    expect(captured?.readFileState.get("/keep.md")).toEqual({ keep: true });
    expect(parentReadFileState.has(docPath)).toBe(true);
    expect(parentReadFileState.has("/mutated.md")).toBe(false);
  });

  it("skips updates when the last assistant turn still has tool calls", async () => {
    const docPath = join(tempRoot, "notes.md");
    await writeFile(docPath, "# MAGIC DOC: Notes\n\nBody\n", "utf8");
    registerMagicDoc(docPath);
    let calls = 0;
    setMagicDocsAgentRunnerForTests(async () => {
      calls += 1;
    });

    await runMagicDocsPostSamplingHook({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "FileRead", arguments: "{}" }],
        },
      ],
      querySource: "repl_main_thread",
    });

    expect(calls).toBe(0);
  });

  it("evicts tracked docs that are deleted or inaccessible", async () => {
    const missingPath = join(tempRoot, "missing.md");
    registerMagicDoc(missingPath);
    setMagicDocsAgentRunnerForTests(async () => {});

    await runMagicDocsPostSamplingHook({
      messages: idleMessages,
      querySource: "repl_main_thread",
    });

    expect(trackedMagicDocPathsForTests()).toEqual([]);
  });

  it("allows Edit only for the tracked Magic Doc path", async () => {
    const policy = createMagicDocsEditPolicy("/tmp/doc.md");

    await expect(
      Promise.resolve(policy({ name: "Edit" }, { file_path: "/tmp/doc.md" })),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(
      Promise.resolve(policy({ name: "Edit" }, { file_path: "/tmp/other.md" })),
    ).resolves.toMatchObject({ behavior: "deny" });
    await expect(
      Promise.resolve(policy({ name: "FileRead" }, { file_path: "/tmp/doc.md" })),
    ).resolves.toMatchObject({ behavior: "deny" });
  });
});
