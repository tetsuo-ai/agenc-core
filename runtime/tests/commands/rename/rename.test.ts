import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../../tools.js", () => ({
  getAllTools: () => [],
  getDefaultTools: () => [],
}));

const teammateMock = vi.fn(() => false);
const saveCustomTitleMock = vi.fn(async () => {});
const saveAgentNameMock = vi.fn(async () => {});
const generateSessionNameMock = vi.fn(async () => "auto-generated-name");

vi.mock("../../utils/teammate.js", () => ({
  isTeammate: () => teammateMock(),
}));
vi.mock("../../utils/sessionStorage.js", () => ({
  saveCustomTitle: saveCustomTitleMock,
  saveAgentName: saveAgentNameMock,
  getTranscriptPath: () => "/tmp/transcript.jsonl",
}));
vi.mock("../../bootstrap/state.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getSessionId: () => "session-abc1",
  };
});
vi.mock("../../bridge/bridgeConfig.js", () => ({
  getBridgeBaseUrlOverride: () => undefined,
  getBridgeTokenOverride: () => undefined,
}));
vi.mock("./generateSessionName.js", () => ({
  generateSessionName: generateSessionNameMock,
}));

const { call } = await import("./rename.js");

afterEach(() => {
  teammateMock.mockReturnValue(false);
  saveCustomTitleMock.mockClear();
  saveAgentNameMock.mockClear();
  generateSessionNameMock.mockClear().mockResolvedValue("auto-generated-name");
});

const baseContext = {
  setAppState: vi.fn(),
  getAppState: () => ({}),
  abortController: new AbortController(),
  messages: [],
} as never;

function makeOnDone() {
  const calls: Array<{ message: string | undefined; opts: Record<string, unknown> }> = [];
  return {
    onDone: (m: string | undefined, o: Record<string, unknown>) => {
      calls.push({ message: m, opts: o });
    },
    calls,
  };
}

describe("/rename call()", () => {
  it("rejects when the session is a swarm teammate", async () => {
    teammateMock.mockReturnValue(true);
    const { onDone, calls } = makeOnDone();
    await call(onDone, baseContext, "new-name");
    expect(calls[0].message).toContain("Cannot rename");
    expect(saveCustomTitleMock).not.toHaveBeenCalled();
  });

  it("uses the explicit arg as the new name", async () => {
    const { onDone, calls } = makeOnDone();
    await call(onDone, baseContext, "  my-feature-branch  ");
    expect(saveCustomTitleMock).toHaveBeenCalledWith(
      "session-abc1",
      "my-feature-branch",
      "/tmp/transcript.jsonl",
    );
    expect(saveAgentNameMock).toHaveBeenCalledWith(
      "session-abc1",
      "my-feature-branch",
      "/tmp/transcript.jsonl",
    );
    expect(calls[0].message).toContain("Session renamed to: my-feature-branch");
  });

  it("falls back to generateSessionName when args is empty", async () => {
    generateSessionNameMock.mockResolvedValue("auto-snippet");
    const { onDone, calls } = makeOnDone();
    await call(onDone, baseContext, "");
    expect(generateSessionNameMock).toHaveBeenCalled();
    expect(saveCustomTitleMock).toHaveBeenCalledWith(
      "session-abc1",
      "auto-snippet",
      "/tmp/transcript.jsonl",
    );
    expect(calls[0].message).toContain("auto-snippet");
  });

  it("returns the no-context error when generateSessionName produces nothing", async () => {
    generateSessionNameMock.mockResolvedValue(null);
    const { onDone, calls } = makeOnDone();
    await call(onDone, baseContext, "");
    expect(calls[0].message).toContain("Could not generate a name");
    expect(saveCustomTitleMock).not.toHaveBeenCalled();
  });
});
