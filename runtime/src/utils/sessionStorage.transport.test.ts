import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockedState = vi.hoisted(() => ({
  sessionId: "session-under-test",
  originalCwd: "/workspace/project",
}));

const mocks = vi.hoisted(() => ({
  appendSessionLog: vi.fn(),
  getSessionLogs: vi.fn(),
  logForDebugging: vi.fn(),
  logForDiagnosticsNoPII: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("../bootstrap/state.js", () => ({
  getOriginalCwd: () => mockedState.originalCwd,
  getPlanSlugCache: () => new Map(),
  getPromptId: () => "prompt-1",
  getSessionId: () => mockedState.sessionId,
  getSessionProjectDir: () => null,
  isSessionPersistenceDisabled: () => false,
  switchSession: (sessionId: string) => {
    mockedState.sessionId = sessionId;
  },
}));

vi.mock("../services/api/sessionIngress.js", () => ({
  appendSessionLog: mocks.appendSessionLog,
  getSessionLogs: mocks.getSessionLogs,
}));

vi.mock("./debug.js", () => ({
  logForDebugging: mocks.logForDebugging,
}));

vi.mock("./diagLogs.js", () => ({
  logForDiagnosticsNoPII: mocks.logForDiagnosticsNoPII,
}));

vi.mock("src/services/analytics/index.js", () => ({
  logEvent: mocks.logEvent,
}));

describe("sessionStorage transport-aware hydration", () => {
  let configDir = "";
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    configDir = mkdtempSync(join(tmpdir(), "agenc-session-storage-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    delete process.env.CLAUDE_CODE_USE_CCR_V2;
    delete process.env.AGENC_TRANSPORT;
    mockedState.sessionId = "session-under-test";
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    delete process.env.CLAUDE_CODE_USE_CCR_V2;
    delete process.env.AGENC_TRANSPORT;
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("hydrates through session-ingress when CCR v2 is not selected", async () => {
    mocks.getSessionLogs.mockResolvedValueOnce([
      { uuid: "u-1", type: "user" },
      { uuid: "u-2", type: "assistant" },
    ]);

    const storage = await import("./sessionStorage.js");
    storage.resetProjectForTesting();

    await expect(
      storage.hydrateRemoteSession(
        "session-v1",
        "https://example.test/v1/session_ingress/session/session-v1",
      ),
    ).resolves.toBe(true);

    expect(mocks.getSessionLogs).toHaveBeenCalledWith(
      "session-v1",
      "https://example.test/v1/session_ingress/session/session-v1",
    );

    const transcript = readFileSync(
      storage.getTranscriptPathForSession("session-v1"),
      "utf8",
    );
    expect(transcript.trim().split("\n")).toEqual([
      JSON.stringify({ uuid: "u-1", type: "user" }),
      JSON.stringify({ uuid: "u-2", type: "assistant" }),
    ]);
  });

  it("routes CCR v2 hydration through internal events when the ladder selects SSE", async () => {
    process.env.CLAUDE_CODE_USE_CCR_V2 = "1";
    mocks.getSessionLogs.mockResolvedValueOnce([
      { uuid: "unexpected", type: "user" },
    ]);

    const storage = await import("./sessionStorage.js");
    storage.resetProjectForTesting();
    storage.setInternalEventReader(
      async () => [
        {
          payload: { uuid: "fg-1", type: "user" },
        },
        {
          payload: { uuid: "fg-2", type: "assistant" },
        },
      ],
      async () => [],
    );

    await expect(
      storage.hydrateRemoteSession(
        "session-v2",
        "https://example.test/v1/session_ingress/session/session-v2",
      ),
    ).resolves.toBe(true);

    expect(mocks.getSessionLogs).not.toHaveBeenCalled();

    const transcript = readFileSync(
      storage.getTranscriptPathForSession("session-v2"),
      "utf8",
    );
    expect(transcript.trim().split("\n")).toEqual([
      JSON.stringify({ uuid: "fg-1", type: "user" }),
      JSON.stringify({ uuid: "fg-2", type: "assistant" }),
    ]);
  });

  it("exposes the hydration routing decision as a small pure helper", async () => {
    const storage = await import("./sessionStorage.js");
    expect(storage.shouldHydrateViaInternalEvents("sse", true)).toBe(true);
    expect(storage.shouldHydrateViaInternalEvents("sse", false)).toBe(false);
    expect(storage.shouldHydrateViaInternalEvents("hybrid", true)).toBe(false);
  });
});
