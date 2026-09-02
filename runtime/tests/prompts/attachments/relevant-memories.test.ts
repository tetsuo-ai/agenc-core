/**
 * Tests for the relevant durable-memory attachment producer.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const memoryAuthority = vi.hoisted(() => ({ enabled: true }));

vi.mock("../../utils/settings/settings.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../utils/settings/settings.js")
  >();
  return {
    ...actual,
    getExecutionAuthoritySettings: () => ({
      autoMemoryEnabled: memoryAuthority.enabled,
    }),
  };
});

import { getProjectRoot, setProjectRoot } from "../../bootstrap/state.js";
import { ConfigStore } from "../../config/store.js";
import {
  getAttachmentTrackingState,
  resetRelevantMemoryBudget,
} from "../../session/attachment-state.js";
import type {
  AdmittedMemorySelector,
  MemorySelectorRequest,
} from "../../memory/recall-contract.js";
import { closeFullCorpusMemoryIndexes } from "../../memory/find-relevant.js";
import { getProjectMemoryPath } from "../../memory/paths.js";
import {
  enterCanonicalSettingsAuthority,
  resetCanonicalSettingsAuthorityForTesting,
} from "../../utils/settings/canonicalAuthority.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";
import { relevantMemoriesProducer } from "./relevant-memories.js";

let root: string;
let cwd: string;
let agencHome: string;
/** Project memory root shared with the prompt and the extraction child. */
let projectMemoryDir: string;
let savedAgencHome: string | undefined;
let savedProjectRoot = "";
let selectedMemoryTitle = "";
const selectorCall = vi.fn(async (request: MemorySelectorRequest) => ({
  kind: "selected" as const,
  candidateIds: request.candidates
    .filter((candidate) => candidate.title === selectedMemoryTitle)
    .map((candidate) => candidate.id),
}));
const admittedMemorySelector: AdmittedMemorySelector = {
  select: selectorCall,
};

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "agenc-relevant-memory-"));
  cwd = join(root, "repo");
  agencHome = join(root, "home");
  mkdirSync(join(agencHome, "memory"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  savedAgencHome = process.env.AGENC_HOME;
  savedProjectRoot = getProjectRoot();
  process.env.AGENC_HOME = agencHome;
  setProjectRoot(cwd);
  installMemoryAuthority();
  projectMemoryDir = getProjectMemoryPath();
  mkdirSync(projectMemoryDir, { recursive: true });
  memoryAuthority.enabled = true;
  selectedMemoryTitle = "";
  selectorCall.mockClear();
});

afterEach(() => {
  closeFullCorpusMemoryIndexes();
  setProjectRoot(savedProjectRoot);
  resetCanonicalSettingsAuthorityForTesting();
  getProjectMemoryPath.cache?.clear?.();
  if (savedAgencHome === undefined) {
    delete process.env.AGENC_HOME;
  } else {
    process.env.AGENC_HOME = savedAgencHome;
  }
  rmSync(root, { recursive: true, force: true });
});

/**
 * The canonical settings authority is AsyncLocalStorage-scoped, so it has to
 * be entered inside each test body as well as in `beforeEach` (the vitest
 * setup harness re-enters its own hermetic authority around hooks).
 */
function installMemoryAuthority(): void {
  enterCanonicalSettingsAuthority(
    new ConfigStore({
      home: agencHome,
      env: { ...process.env, AGENC_HOME: agencHome },
      cwd,
    }),
  );
  getProjectMemoryPath.cache?.clear?.();
}

function makeOpts(
  partial?: Partial<GetAttachmentsOptions>,
): GetAttachmentsOptions {
  return {
    sessionKey: {},
    userInput: "use browser automation",
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd,
    subagentDepth: 0,
    signal: new AbortController().signal,
    agencHome,
    admittedMemorySelector,
    ...partial,
  };
}

function writeMemory(
  dir: string,
  name: string,
  description: string,
  content: string,
): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      "---",
      `description: ${description}`,
      "type: usage",
      "---",
      "",
      content,
    ].join("\n"),
    "utf8",
  );
  return path;
}

function selectMemory(name: string): void {
  selectedMemoryTitle = name.replace(/\.md$/u, "");
}

/**
 * Enough extra matches to exceed MAX_RELEVANT_MEMORIES so the model-based
 * selector is consulted; below that bound recall stays lexical and skips the
 * main-model round trip.
 */
function writeFillerMemories(dir: string, term: string, count = 5): void {
  for (let index = 0; index < count; index += 1) {
    writeMemory(
      dir,
      `filler-${index}.md`,
      `${term} filler ${index}`,
      `Filler ${index} for ${term}.`,
    );
  }
}

describe("relevantMemoriesProducer", () => {
  test("skips without an AgenC home", async () => {
    installMemoryAuthority();
    const trackingState = getAttachmentTrackingState({});
    const out = await relevantMemoriesProducer(
      makeOpts({ agencHome: undefined }),
      trackingState,
    );
    expect(out).toEqual([]);
    expect(selectorCall).not.toHaveBeenCalled();
  });

  test("recalls a matching memory for a one-word prompt without a selector round trip", async () => {
    installMemoryAuthority();
    const memoryPath = writeMemory(
      join(agencHome, "memory"),
      "browser.md",
      "Browser guidance",
      "Use the browser workflow.",
    );
    selectMemory("browser.md");
    const trackingState = getAttachmentTrackingState({});
    const out = await relevantMemoriesProducer(
      makeOpts({ userInput: "browser" }),
      trackingState,
    );
    // One candidate already fits the attachment limit: no main-model call.
    expect(out).toMatchObject([
      {
        kind: "relevant_memories",
        memories: [{ path: memoryPath, selectionSource: "lexical" }],
      },
    ]);
    expect(selectorCall).not.toHaveBeenCalled();
  });

  test("reranks through the selector only when more than five candidates match", async () => {
    installMemoryAuthority();
    const memoryDir = join(agencHome, "memory");
    const memoryPath = writeMemory(
      memoryDir,
      "browser.md",
      "Browser guidance",
      "Use the browser workflow.",
    );
    writeFillerMemories(memoryDir, "browser");
    selectMemory("browser.md");
    const trackingState = getAttachmentTrackingState({});
    const out = await relevantMemoriesProducer(
      makeOpts({ userInput: "browser" }),
      trackingState,
    );
    expect(out).toMatchObject([
      {
        kind: "relevant_memories",
        memories: [{ path: memoryPath, selectionSource: "reranked" }],
      },
    ]);
    expect(selectorCall).toHaveBeenCalledTimes(1);
    expect(selectorCall.mock.calls[0]?.[0].candidates).toHaveLength(6);
  });

  test("skips when auto-memory is disabled", async () => {
    installMemoryAuthority();
    memoryAuthority.enabled = false;
    const trackingState = getAttachmentTrackingState({});
    const out = await relevantMemoriesProducer(makeOpts(), trackingState);
    expect(out).toEqual([]);
    expect(selectorCall).not.toHaveBeenCalled();
  });

  test("surfaces selected durable memory with bounded content and citation metadata", async () => {
    installMemoryAuthority();
    const memoryDir = join(agencHome, "memory");
    const memoryPath = writeMemory(
      memoryDir,
      "browser.md",
      "Browser automation guidance",
      "Use the browser automation workflow.",
    );
    writeFillerMemories(memoryDir, "browser automation");
    selectMemory("browser.md");
    const trackingState = getAttachmentTrackingState({});

    const out = await relevantMemoriesProducer(
      makeOpts({
        messages: [
          { role: "user", content: "use browser automation" },
          {
            role: "tool",
            content: "completed",
            toolCallId: "tool-1",
            toolName: "browser",
          },
        ],
      }),
      trackingState,
    );

    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("relevant_memories");
    if (out[0]?.kind !== "relevant_memories") {
      throw new Error("expected relevant_memories");
    }
    expect(out[0].memories).toHaveLength(1);
    expect(out[0].memories[0]?.path).toBe(memoryPath);
    expect(out[0].memories[0]?.content).toContain(
      "Use the browser automation workflow.",
    );
    expect(out[0].memories[0]?.header).toContain("Memory");
    expect(out[0].memories[0]?.citation?.path).toBe(memoryPath);
    expect(trackingState.surfacedRelevantMemoryPaths.has(memoryPath)).toBe(
      true,
    );
    expect(trackingState.surfacedRelevantMemoryBytes).toBeGreaterThan(0);
    expect(selectorCall.mock.calls[0]?.[0].recentTools).toEqual(["browser"]);
  });

  test("surfaces a matching memory again on the next request", async () => {
    installMemoryAuthority();
    const memoryDir = join(agencHome, "memory");
    const memoryPath = writeMemory(
      memoryDir,
      "browser.md",
      "Browser automation guidance",
      "Use the browser automation workflow.",
    );
    selectMemory("browser.md");
    const trackingState = getAttachmentTrackingState({});

    // Attachments live only in the request projection, so a memory that
    // matched the previous request must be shown again, not blocked for the
    // rest of the session.
    const first = await relevantMemoriesProducer(makeOpts(), trackingState);
    const second = await relevantMemoriesProducer(makeOpts(), trackingState);

    for (const out of [first, second]) {
      expect(out).toMatchObject([
        { kind: "relevant_memories", memories: [{ path: memoryPath }] },
      ]);
    }
    expect(trackingState.surfacedRelevantMemoryPaths).toEqual(new Set([memoryPath]));
    expect(trackingState.surfacedRelevantMemoryBytes).toBeGreaterThan(0);
  });

  test("compaction resets the cumulative recall budget", async () => {
    installMemoryAuthority();
    const memoryDir = join(agencHome, "memory");
    writeMemory(
      memoryDir,
      "browser.md",
      "Browser automation guidance",
      "Use the browser automation workflow.",
    );
    selectMemory("browser.md");
    const sessionKey = {};
    const trackingState = getAttachmentTrackingState(sessionKey);
    trackingState.surfacedRelevantMemoryBytes = 60 * 1_024;

    expect(await relevantMemoriesProducer(makeOpts(), trackingState)).toEqual([]);

    resetRelevantMemoryBudget(sessionKey);
    expect(trackingState.surfacedRelevantMemoryBytes).toBe(0);
    const out = await relevantMemoriesProducer(makeOpts(), trackingState);
    expect(out).toHaveLength(1);
  });

  test("injects project/CWD-keyed memories on the first turn without a user query", async () => {
    installMemoryAuthority();
        const globalMemoryDir = join(agencHome, "memory");
    const projectPath = writeMemory(
      projectMemoryDir,
      "build-notes.md",
      "Build pipeline notes",
      "Run the runtime build twice.",
    );
    const matchingGlobalPath = writeMemory(
      globalMemoryDir,
      "repo-conventions.md",
      "Conventions for this workspace",
      "Follow the workspace conventions.",
    );
    const unrelatedGlobalPath = writeMemory(
      globalMemoryDir,
      "cooking.md",
      "Slow braising technique",
      "Simmer gently for hours.",
    );
    const trackingState = getAttachmentTrackingState({});

    const out = await relevantMemoriesProducer(
      makeOpts({ userInput: null }),
      trackingState,
    );

    // Session-start recall must stay cheap: no model-side selection.
    expect(selectorCall).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    if (out[0]?.kind !== "relevant_memories") {
      throw new Error("expected relevant_memories");
    }
    const paths = out[0].memories.map((memory) => memory.path);
    expect(new Set(paths)).toEqual(
      new Set([projectPath, matchingGlobalPath, unrelatedGlobalPath]),
    );
    expect(
      out[0].memories.find((memory) => memory.path === projectPath)?.content,
    ).toContain("Run the runtime build twice.");
    expect(
      out[0].memories.every((memory) => memory.selectionSource === "lexical"),
    ).toBe(true);
    expect(trackingState.surfacedRelevantMemoryPaths.has(projectPath)).toBe(
      true,
    );
    expect(trackingState.surfacedRelevantMemoryBytes).toBeGreaterThan(0);
  });

  test("session-start recall fires only on the first producer run", async () => {
    installMemoryAuthority();
        writeMemory(
      projectMemoryDir,
      "build-notes.md",
      "Build pipeline notes",
      "Run the runtime build twice.",
    );
    const trackingState = getAttachmentTrackingState({});

    const first = await relevantMemoriesProducer(
      makeOpts({ userInput: "" }),
      trackingState,
    );
    expect(first).toHaveLength(1);

    // Later query-less turns must not re-run session-start recall, even for
    // memories that were not surfaced the first time.
    writeMemory(
      projectMemoryDir,
      "later-notes.md",
      "Follow-up notes",
      "Written after turn 0.",
    );
    const second = await relevantMemoriesProducer(
      makeOpts({ userInput: "" }),
      trackingState,
    );
    expect(second).toEqual([]);
    expect(selectorCall).not.toHaveBeenCalled();
  });

  test("skips session-start recall for subagents", async () => {
    installMemoryAuthority();
    writeMemory(
      projectMemoryDir,
      "build-notes.md",
      "Build pipeline notes",
      "Run the runtime build twice.",
    );
    const trackingState = getAttachmentTrackingState({});
    const out = await relevantMemoriesProducer(
      makeOpts({ userInput: null, subagentDepth: 1 }),
      trackingState,
    );
    expect(out).toEqual([]);
    expect(selectorCall).not.toHaveBeenCalled();
  });

  test("does not double-inject when the first prompt is a real query", async () => {
    installMemoryAuthority();
    const globalMemoryDir = join(agencHome, "memory");
    const browserPath = writeMemory(
      globalMemoryDir,
      "browser.md",
      "Browser automation guidance",
      "Use the browser automation workflow.",
    );
    writeMemory(
      projectMemoryDir,
      "build-notes.md",
      "Build pipeline notes",
      "Run the runtime build twice.",
    );
    selectMemory("browser.md");
    const trackingState = getAttachmentTrackingState({});

    // Turn 0 with a substantive query: only the query-gated path fires.
    const out = await relevantMemoriesProducer(makeOpts(), trackingState);
    expect(out).toHaveLength(1);
    if (out[0]?.kind !== "relevant_memories") {
      throw new Error("expected relevant_memories");
    }
    expect(out[0].memories.map((memory) => memory.path)).toEqual([browserPath]);

    // The session-start one-shot was consumed by turn 0, so a later
    // query-less turn injects nothing on top.
    const second = await relevantMemoriesProducer(
      makeOpts({ userInput: null }),
      trackingState,
    );
    expect(second).toEqual([]);
  });

  test("redacts secrets in recalled memory content", async () => {
    installMemoryAuthority();
    const token = `ghp_${"A".repeat(36)}`;
    writeMemory(
      join(agencHome, "memory"),
      "browser.md",
      "Browser automation guidance",
      `Use the browser workflow with token=${token} for the staging bot.`,
    );
    const trackingState = getAttachmentTrackingState({});

    const out = await relevantMemoriesProducer(makeOpts(), trackingState);

    expect(out[0]?.kind).toBe("relevant_memories");
    if (out[0]?.kind !== "relevant_memories") {
      throw new Error("expected relevant_memories");
    }
    expect(out[0].memories[0]?.content).toContain("token=[REDACTED]");
    expect(out[0].memories[0]?.content).not.toContain(token);
  });

  test("truncates large selected memories before attachment emission", async () => {
    installMemoryAuthority();
    const memoryDir = join(agencHome, "memory");
    writeMemory(
      memoryDir,
      "large.md",
      "Large browser guidance",
      Array.from({ length: 260 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join(
        "\n",
      ),
    );
    selectMemory("large.md");
    const trackingState = getAttachmentTrackingState({});

    const out = await relevantMemoriesProducer(makeOpts(), trackingState);

    expect(out[0]?.kind).toBe("relevant_memories");
    if (out[0]?.kind !== "relevant_memories") {
      throw new Error("expected relevant_memories");
    }
    expect(out[0].memories[0]?.content).toContain(
      "This memory file was truncated",
    );
    expect(out[0].memories[0]?.limit).toBeTypeOf("number");
    expect(
      Buffer.byteLength(out[0].memories[0]?.content ?? "", "utf8"),
    ).toBeLessThan(5000);
  });

  test("never crosses the cumulative session byte budget with truncation metadata", async () => {
    installMemoryAuthority();
    const memoryDir = join(agencHome, "memory");
    writeMemory(
      memoryDir,
      "large.md",
      "Large browser guidance",
      "browser ".repeat(2_000),
    );
    selectMemory("large.md");
    const trackingState = getAttachmentTrackingState({});
    trackingState.surfacedRelevantMemoryBytes = 60 * 1_024 - 8;

    const out = await relevantMemoriesProducer(makeOpts(), trackingState);

    expect(out[0]?.kind).toBe("relevant_memories");
    expect(trackingState.surfacedRelevantMemoryBytes).toBeLessThanOrEqual(
      60 * 1_024,
    );
  });
});
