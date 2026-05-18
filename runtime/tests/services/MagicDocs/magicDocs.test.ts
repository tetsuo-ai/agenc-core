import {
  readFile,
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
  vi,
} from "vitest";

import type { LLMMessage } from "../../llm/types.js";
import type { RunAgentParams } from "../../agents/run-agent.js";
import { clearFileReadListenersForTests, createFileReadTool, registerFileReadListener } from "../../tools/system/file-read.js";
import {
  clearSessionReadState,
  getSessionReadSnapshot,
  seedSessionReadState,
  SESSION_ID_ARG,
} from "../../tools/system/filesystem.js";
import type { Session } from "../../session/session.js";
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

const runAgentMockState = vi.hoisted(() => ({
  calls: [] as unknown[],
}));

vi.mock("../../agents/run-agent.js", () => ({
  runAgent: async function* (params: unknown) {
    runAgentMockState.calls.push(params);
    return {
      threadId: "magic-docs-child",
      durationMs: 0,
      outcome: "completed",
    };
  },
}));

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
  runAgentMockState.calls.length = 0;
});

afterEach(async () => {
  resetMagicDocsForTests();
  clearFileReadListenersForTests();
  runAgentMockState.calls.length = 0;
  if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousAgencHome;
  if (previousAgencConfigDir === undefined) delete process.env.AGENC_CONFIG_DIR;
  else process.env.AGENC_CONFIG_DIR = previousAgencConfigDir;
  await rm(tempRoot, { recursive: true, force: true });
});

function makeMagicDocsSession(
  sessionId: string,
  childId: string,
): Session {
  return {
    conversationId: sessionId,
    sessionConfiguration: {
      sessionSource: "cli_main",
    },
    services: {
      agentControl: {
        spawn: async () => ({
          agentId: childId,
          agentPath: "/root/magic-docs",
          nickname: "magic-docs",
          depth: 1,
          role: { name: "magic-docs", config: {} },
          abortController: new AbortController(),
        }),
      },
    },
  } as unknown as Session;
}

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
    expect(trackedMagicDocPathsForTests("session-1")).toEqual([docPath]);
  });

  it("registers tagged markdown from raw text even when FileRead returns a slice", async () => {
    const docPath = join(tempRoot, "partial.md");
    await writeFile(
      docPath,
      "# MAGIC DOC: Partial\n\nHidden body\nVisible slice\n",
      "utf8",
    );
    initMagicDocs();

    const tool = createFileReadTool({ allowedPaths: [tempRoot] });
    const result = await tool.execute({
      file_path: docPath,
      offset: 4,
      limit: 1,
      [SESSION_ID_ARG]: "session-partial",
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).not.toContain("MAGIC DOC");
    expect(trackedMagicDocPathsForTests("session-partial")).toEqual([docPath]);
  });

  it("does not let listener failures break successful FileRead calls", async () => {
    const docPath = join(tempRoot, "listener.md");
    await writeFile(docPath, "# MAGIC DOC: Listener\n\nBody\n", "utf8");
    let survivingListenerCalls = 0;
    registerFileReadListener(() => {
      throw new Error("listener failed");
    });
    registerFileReadListener(() => {
      survivingListenerCalls += 1;
    });

    const tool = createFileReadTool({ allowedPaths: [tempRoot] });
    const result = await tool.execute({
      file_path: docPath,
      [SESSION_ID_ARG]: "session-listener",
    });

    expect(result.isError).not.toBe(true);
    expect(survivingListenerCalls).toBe(1);
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
      ["/keep.md", { content: "keep", viewKind: "full" }],
    ]);
    let captured: MagicDocsAgentRequest | null = null;
    setMagicDocsAgentRunnerForTests(async (request) => {
      captured = request;
      request.readFileState.set("/mutated.md", {});
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
    expect(captured?.readFileState.get("/keep.md")).toEqual({
      content: "keep",
      viewKind: "full",
    });
    expect(parentReadFileState.has(docPath)).toBe(true);
    expect(parentReadFileState.has("/mutated.md")).toBe(false);
  });

  it("only updates docs tracked by the current session scope", async () => {
    const firstPath = join(tempRoot, "first.md");
    const secondPath = join(tempRoot, "second.md");
    await writeFile(firstPath, "# MAGIC DOC: First\n\nBody\n", "utf8");
    await writeFile(secondPath, "# MAGIC DOC: Second\n\nBody\n", "utf8");
    registerMagicDoc(firstPath, "session-a");
    registerMagicDoc(secondPath, "session-b");
    const seen: string[] = [];
    setMagicDocsAgentRunnerForTests(async (request) => {
      seen.push(request.docPath);
    });

    await runMagicDocsPostSamplingHook({
      messages: idleMessages,
      querySource: "repl_main_thread",
      sessionId: "session-a",
    });

    expect(seen).toEqual([firstPath]);
    expect(trackedMagicDocPathsForTests()).toEqual([firstPath, secondPath]);
  });

  it("skips updates for non-main query sources", async () => {
    const docPath = join(tempRoot, "notes.md");
    await writeFile(docPath, "# MAGIC DOC: Notes\n\nBody\n", "utf8");
    registerMagicDoc(docPath, "session-1");
    let calls = 0;
    setMagicDocsAgentRunnerForTests(async () => {
      calls += 1;
    });

    await runMagicDocsPostSamplingHook({
      messages: idleMessages,
      querySource: "magic_docs",
      sessionId: "session-1",
    });
    await runMagicDocsPostSamplingHook({
      messages: idleMessages,
      querySource: "agent:child-1",
      sessionId: "session-1",
    });

    expect(calls).toBe(0);
  });

  it("seeds the real MagicDocs child with cloned parent read state", async () => {
    const parentId = "parent-session";
    const childId = "child-session";
    const docPath = join(tempRoot, "architecture.md");
    const otherPath = join(tempRoot, "other.md");
    await writeFile(docPath, "# MAGIC DOC: Architecture\n\nCurrent body\n", "utf8");
    await writeFile(otherPath, "Other context\n", "utf8");
    seedSessionReadState(parentId, [
      {
        path: docPath,
        content: "stale body",
        rawContent: "stale body",
        timestamp: 1,
        viewKind: "full",
      },
      {
        path: otherPath,
        content: "Other context\n",
        rawContent: "Other context\n",
        timestamp: 2,
        viewKind: "full",
      },
    ]);
    registerMagicDoc(docPath, parentId);

    await runMagicDocsPostSamplingHook({
      messages: idleMessages,
      querySource: "repl_main_thread",
      session: makeMagicDocsSession(parentId, childId),
    });

    expect(runAgentMockState.calls).toHaveLength(1);
    const params = runAgentMockState.calls[0] as RunAgentParams;
    expect(params.querySource).toBe("magic_docs");
    expect(params.toolAllowlist).toEqual(["Edit"]);
    expect(getSessionReadSnapshot(childId, otherPath)?.content).toBe("Other context\n");
    expect(getSessionReadSnapshot(childId, docPath)?.rawContent).toBe(
      await readFile(docPath, "utf8"),
    );
    expect(getSessionReadSnapshot(childId, docPath)?.content).not.toBe("stale body");

    clearSessionReadState(parentId);
    clearSessionReadState(childId);
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
