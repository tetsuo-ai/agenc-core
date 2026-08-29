import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCurrentRuntimeSession,
  runWithCurrentRuntimeSession,
} from "../../../src/session/current-session.js";
import { resolveAgentRuntimeOptions } from "../../../src/session/runtime-options.js";
import type { Session } from "../../../src/session/session.js";
import {
  flushSessionStorage,
  resetProjectForTesting,
  setSessionFileForTesting,
} from "../../../src/utils/sessionStorage.js";

const runForkedAgentMock = vi.hoisted(() => vi.fn());

vi.mock("./promptSuggestion.js", () => ({
  generateSuggestion: vi.fn(),
  getPromptVariant: () => "user_intent",
  getSuggestionSuppressReason: () => null,
  logSuggestionSuppressed: vi.fn(),
  shouldFilterSuggestion: () => false,
}));

vi.mock("./runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime.js")>("./runtime.js");
  return {
    ...actual,
    runForkedAgent: runForkedAgentMock,
  };
});

import {
  abortSpeculation,
  acceptSpeculation,
  handleSpeculationAccept,
  isSpeculationEnabled,
  prepareMessagesForInjection,
  startSpeculation,
} from "./speculation.js";

describe("PromptSuggestion speculation", () => {
  const tempDirs: string[] = [];
  const originalCwd = process.env.AGENC_CWD;

  afterEach(async () => {
    runForkedAgentMock.mockReset();
    clearCurrentRuntimeSession();
    resetProjectForTesting();
    process.env.AGENC_CWD = originalCwd;
    delete process.env.USER_TYPE;
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE;
    await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("uses only the persisted speculation setting", () => {
    process.env.USER_TYPE = "ant";

    expect(isSpeculationEnabled(false)).toBe(false);
    expect(isSpeculationEnabled(true)).toBe(true);

  });

  it("keeps successful tool uses and strips pending or internal blocks", () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", text: "hidden" },
            { type: "tool_use", id: "ok", name: "FileRead" },
            { type: "tool_use", id: "pending", name: "Write" },
            { type: "text", text: "visible" },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "ok", content: "done" },
            { type: "tool_result", tool_use_id: "failed", is_error: true },
          ],
        },
      },
    ] as any;

    const cleaned = prepareMessagesForInjection(messages);

    expect(cleaned).toHaveLength(2);
    expect(cleaned[0].message.content).toEqual([
      { type: "tool_use", id: "ok", name: "FileRead" },
      { type: "text", text: "visible" },
    ]);
    expect(cleaned[1].message.content).toEqual([
      { type: "tool_result", tool_use_id: "ok", content: "done" },
    ]);
  });

  it("drops messages that become whitespace-only after cleanup", () => {
    const cleaned = prepareMessagesForInjection([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "pending", name: "Write" },
            { type: "text", text: "   " },
          ],
        },
      },
    ] as any);

    expect(cleaned).toEqual([]);
  });

  it("falls back to a query without injecting speculation when overlay copy fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agenc-copy-fail-"));
    tempDirs.push(cwd);
    process.env.AGENC_CWD = cwd;

    let appState = {
      promptSuggestion: {
        text: "follow up",
        promptId: "user_intent",
        shownAt: Date.now(),
        acceptedAt: 0,
        generationRequestId: null,
      },
      speculation: { status: "idle" },
      speculationSessionTimeSavedMs: 0,
    } as any;
    const setAppState = (fn: (prev: any) => any) => {
      appState = fn(appState);
    };
    let messages: any[] = [];
    const setMessages = (fn: (prev: any[]) => any[]) => {
      messages = fn(messages);
    };

    const state = {
      status: "active",
      id: "missing-overlay",
      abort: vi.fn(),
      startTime: Date.now() - 100,
      messagesRef: {
        current: [
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "speculated answer" }],
            },
          },
        ],
      },
      writtenPathsRef: { current: new Set(["missing.txt"]) },
      overlayPath: join(cwd, "missing-overlay"),
      boundary: { type: "complete", completedAt: Date.now(), outputTokens: 1 },
      suggestionLength: 9,
      toolUseCount: 0,
      isPipelined: false,
      cwd,
      contextRef: { current: {} },
      pipelinedSuggestion: null,
    } as any;

    const result = await handleSpeculationAccept(state, 0, setAppState, "follow up", {
      setMessages,
      readFileState: { current: new Map() },
      cwd,
    });

    expect(result).toEqual({ queryRequired: true });
    expect(messages).toHaveLength(1);
    expect(messages[0].message.content).toBe("follow up");
    expect(
      messages.some(message =>
        JSON.stringify(message).includes("speculated answer"),
      ),
    ).toBe(false);
    expect(appState.speculation).toEqual({ status: "idle" });
  });

  it("promotes overlay writes into the active session cwd", async () => {
    const launchCwd = await mkdtemp(join(tmpdir(), "agenc-launch-cwd-"));
    const sessionCwd = await mkdtemp(join(tmpdir(), "agenc-session-cwd-"));
    tempDirs.push(launchCwd, sessionCwd);
    process.env.AGENC_CWD = launchCwd;

    const sessionTempRoot = await mkdtemp(join(tmpdir(), "agenc-session-temp-"));
    tempDirs.push(sessionTempRoot);
    process.env.USER_TYPE = "ant";
    runForkedAgentMock.mockResolvedValueOnce({
      messages: [],
      totalUsage: { output_tokens: 0 },
    });
    let appState = baseSpeculationAppState("acceptEdits") as any;
    const setAppState = (fn: (prev: any) => any) => {
      appState = fn(appState);
    };

    await runInSessionTempRoot(sessionTempRoot, () =>
      startSpeculation(
        "edit notes",
        createSpeculationContext(appState, sessionCwd),
        setAppState,
        false,
        undefined,
        { cwd: sessionCwd, speculationEnabled: true },
      ),
    );
    expect(appState.speculation.status).toBe("active");
    const active = appState.speculation;
    const overlayFile = join(active.overlayPath, "changed.txt");
    await mkdir(dirname(overlayFile), { recursive: true });
    await writeFile(overlayFile, "from overlay");
    active.writtenPathsRef.current.add("changed.txt");

    const result = await acceptSpeculation(
      active,
      setAppState,
      1,
    );

    expect(result?.boundary?.type).toBe("complete");
    await expect(readFile(join(sessionCwd, "changed.txt"), "utf8")).resolves.toBe(
      "from overlay",
    );
    await expect(readFile(join(launchCwd, "changed.txt"), "utf8")).rejects.toThrow();
    await expect(access(active.overlayPath)).rejects.toThrow();
  });

  it("enforces speculation tool boundaries through startSpeculation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agenc-spec-boundary-"));
    const sessionTempRoot = await mkdtemp(join(tmpdir(), "agenc-spec-temp-"));
    tempDirs.push(cwd, sessionTempRoot);
    process.env.USER_TYPE = "ant";

    const decisions: Array<{ label: string; behavior: string; reason?: string }> = [];
    runForkedAgentMock.mockImplementationOnce(async params => {
      for (const [label, tool, input] of [
        ["read", { name: "FileRead" }, { file_path: join(cwd, "notes.txt") }],
        ["write", { name: "Write" }, { file_path: join(cwd, "notes.txt") }],
        ["bash", { name: "system.bash" }, { command: "git branch -D stale" }],
        ["unknown", { name: "web_fetch" }, { url: "urn:agenc:test-webfetch" }],
      ] as const) {
        const decision = await params.canUseTool(tool, input);
        decisions.push({
          label,
          behavior: decision.behavior,
          reason: decision.decisionReason?.reason,
        });
      }
      return { messages: [], totalUsage: { output_tokens: 0 } };
    });
    let appState = baseSpeculationAppState("default");
    const setAppState = (update: (prev: any) => any) => {
      appState = update(appState);
    };

    await runInSessionTempRoot(sessionTempRoot, () =>
      startSpeculation(
        "run tests",
        createSpeculationContext(appState, cwd),
        setAppState,
        false,
        undefined,
        { cwd, speculationEnabled: true },
      ),
    );

    expect(decisions).toEqual([
      { label: "read", behavior: "allow", reason: "speculation_file_access" },
      { label: "write", behavior: "deny", reason: "speculation_edit_boundary" },
      { label: "bash", behavior: "deny", reason: "speculation_bash_boundary" },
      { label: "unknown", behavior: "deny", reason: "speculation_unknown_tool" },
    ]);
    const overlayPath = (appState.speculation as { overlayPath: string }).overlayPath;
    abortSpeculationForTest(appState, setAppState);
    await expect(access(overlayPath)).rejects.toThrow();
  });

  it("rewrites speculative writes and later reads through the overlay", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agenc-spec-overlay-"));
    const sessionTempRoot = await mkdtemp(join(tmpdir(), "agenc-spec-temp-"));
    tempDirs.push(cwd, sessionTempRoot);
    process.env.USER_TYPE = "ant";
    await writeFile(join(cwd, "notes.txt"), "original");

    let writePath = "";
    let readPath = "";
    runForkedAgentMock.mockImplementationOnce(async params => {
      const write = await params.canUseTool(
        { name: "Write" },
        { file_path: join(cwd, "notes.txt") },
      );
      writePath = String(write.updatedInput?.file_path ?? "");
      const read = await params.canUseTool(
        { name: "FileRead" },
        { file_path: join(cwd, "notes.txt") },
      );
      readPath = String(read.updatedInput?.file_path ?? "");
      return { messages: [], totalUsage: { output_tokens: 0 } };
    });
    let appState = baseSpeculationAppState("acceptEdits");
    const setAppState = (update: (prev: any) => any) => {
      appState = update(appState);
    };

    await runInSessionTempRoot(sessionTempRoot, () =>
      startSpeculation(
        "edit notes",
        createSpeculationContext(appState, cwd),
        setAppState,
        false,
        undefined,
        { cwd, speculationEnabled: true },
      ),
    );

    expect(relative(sessionTempRoot, writePath)).not.toMatch(/^\.\.(?:[\\/]|$)/u);
    expect(readPath).toBe(writePath);
    await expect(readFile(writePath, "utf8")).resolves.toBe("original");
    const overlayPath = (appState.speculation as { overlayPath: string }).overlayPath;
    abortSpeculationForTest(appState, setAppState);
    await expect(access(overlayPath)).rejects.toThrow();
  });

  it("isolates concurrent overlays under each captured session root", async () => {
    const cwdA = await mkdtemp(join(tmpdir(), "agenc-spec-cwd-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "agenc-spec-cwd-b-"));
    const rootA = await mkdtemp(join(tmpdir(), "agenc-spec-root-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "agenc-spec-root-b-"));
    tempDirs.push(cwdA, cwdB, rootA, rootB);
    process.env.USER_TYPE = "ant";
    runForkedAgentMock.mockResolvedValue({
      messages: [],
      totalUsage: { output_tokens: 0 },
    });

    let stateA = baseSpeculationAppState("acceptEdits") as any;
    let stateB = baseSpeculationAppState("acceptEdits") as any;
    const setA = (update: (prev: any) => any) => {
      stateA = update(stateA);
    };
    const setB = (update: (prev: any) => any) => {
      stateB = update(stateB);
    };

    await Promise.all([
      runInSessionTempRoot(rootA, () =>
        startSpeculation(
          "session a",
          createSpeculationContext(stateA, cwdA),
          setA,
          false,
          undefined,
          { cwd: cwdA, speculationEnabled: true },
        ),
      ),
      runInSessionTempRoot(rootB, () =>
        startSpeculation(
          "session b",
          createSpeculationContext(stateB, cwdB),
          setB,
          false,
          undefined,
          { cwd: cwdB, speculationEnabled: true },
        ),
      ),
    ]);

    const overlayA = stateA.speculation.overlayPath as string;
    const overlayB = stateB.speculation.overlayPath as string;
    expect(relative(rootA, overlayA)).not.toMatch(/^\.\.(?:[\\/]|$)/u);
    expect(relative(rootB, overlayB)).not.toMatch(/^\.\.(?:[\\/]|$)/u);
    expect(overlayA).not.toBe(overlayB);

    abortSpeculationForTest(stateA, setA);
    abortSpeculationForTest(stateB, setB);
    await expect(access(overlayA)).rejects.toThrow();
    await expect(access(overlayB)).rejects.toThrow();
  });

  it("queues accepted telemetry through canonical session storage", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agenc-spec-transcript-cwd-"));
    const overlayPath = await mkdtemp(join(tmpdir(), "agenc-spec-transcript-overlay-"));
    const transcriptPath = join(cwd, "session.jsonl");
    tempDirs.push(cwd, overlayPath);
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = "1";
    setSessionFileForTesting(transcriptPath);
    let appState = baseSpeculationAppState("acceptEdits") as any;
    const setAppState = (update: (prev: any) => any) => {
      appState = update(appState);
    };

    await acceptSpeculation(
      {
        status: "active",
        id: "canonical-transcript",
        abort: vi.fn(),
        startTime: Date.now() - 100,
        messagesRef: { current: [] },
        writtenPathsRef: { current: new Set() },
        boundary: { type: "complete", completedAt: Date.now(), outputTokens: 1 },
        suggestionLength: 9,
        toolUseCount: 0,
        isPipelined: false,
        cwd,
        overlayPath,
        contextRef: { current: {} },
        pipelinedSuggestion: null,
      } as any,
      setAppState,
      0,
    );
    await flushSessionStorage();

    const entries = (await readFile(transcriptPath, "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    expect(entries).toEqual([
      expect.objectContaining({ type: "speculation-accept" }),
    ]);
  });
});

function runInSessionTempRoot<T>(
  sessionTempRoot: string,
  operation: () => T,
): T {
  const session = {
    conversationId: `prompt-test-${sessionTempRoot}`,
    services: {
      runtimeOptions: resolveAgentRuntimeOptions({}, { sessionTempRoot }),
    },
  } as unknown as Session;
  return runWithCurrentRuntimeSession(session, operation);
}

function abortSpeculationForTest(
  appState: any,
  setAppState: (update: (prev: any) => any) => void,
): void {
  if (appState.speculation.status !== "active") return;
  abortSpeculation(setAppState);
}

function baseSpeculationAppState(mode: string) {
  return {
    speculation: { status: "idle" },
    speculationSessionTimeSavedMs: 0,
    promptSuggestion: {
      text: null,
      promptId: null,
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: null,
    },
    toolPermissionContext: {
      mode,
      isBypassPermissionsModeAvailable: false,
    },
  };
}

function createSpeculationContext(appState: any, cwd: string) {
  return {
    querySource: "repl_main_thread",
    messages: [],
    systemPrompt: "system",
    userContext: {},
    systemContext: {},
    toolUseContext: {
      abortController: new AbortController(),
      cwd,
      getAppState: () => appState,
      readFileState: new Map(),
    },
  } as any;
}
