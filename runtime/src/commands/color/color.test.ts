import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../../tools.js", () => ({
  getAllTools: () => [],
  getDefaultTools: () => [],
}));

const teammateMock = vi.fn(() => false);
const saveAgentColorMock = vi.fn(async () => {});

vi.mock("../../utils/teammate.js", () => ({
  isTeammate: () => teammateMock(),
}));
vi.mock("../../utils/sessionStorage.js", () => ({
  saveAgentColor: saveAgentColorMock,
  getTranscriptPath: () => "/tmp/transcript.jsonl",
}));
vi.mock("../../bootstrap/state.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getSessionId: () => "session-color-1",
  };
});
vi.mock("src/tools/AgentTool/agentColorManager.js", () => ({
  AGENT_COLORS: ["red", "green", "blue", "purple", "orange"],
}));

const { call } = await import("./color.js");

afterEach(() => {
  teammateMock.mockReturnValue(false);
  saveAgentColorMock.mockClear();
});

const baseContext = {
  setAppState: vi.fn(),
  getAppState: () => ({ standaloneAgentContext: { name: "test" } }),
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

describe("/color call()", () => {
  it("rejects when the session is a swarm teammate", async () => {
    teammateMock.mockReturnValue(true);
    const { onDone, calls } = makeOnDone();
    await call(onDone, baseContext, "blue");
    expect(calls[0].message).toContain("Cannot set color");
    expect(saveAgentColorMock).not.toHaveBeenCalled();
  });

  it("with no args lists available colors", async () => {
    const { onDone, calls } = makeOnDone();
    await call(onDone, baseContext, "");
    expect(calls[0].message).toContain("Please provide a color");
    expect(calls[0].message).toContain("red");
    expect(calls[0].message).toContain("default");
    expect(saveAgentColorMock).not.toHaveBeenCalled();
  });

  it("'default' resets the color (writes 'default' sentinel)", async () => {
    const { onDone, calls } = makeOnDone();
    await call(onDone, baseContext, "default");
    expect(saveAgentColorMock).toHaveBeenCalledWith(
      "session-color-1",
      "default",
      "/tmp/transcript.jsonl",
    );
    expect(calls[0].message).toContain("reset");
  });

  it.each(["reset", "none", "gray", "grey"])(
    "'%s' alias resets the color",
    async (alias) => {
      const { onDone } = makeOnDone();
      await call(onDone, baseContext, alias);
      expect(saveAgentColorMock).toHaveBeenCalledWith(
        "session-color-1",
        "default",
        "/tmp/transcript.jsonl",
      );
    },
  );

  it("a valid color name is saved", async () => {
    const { onDone, calls } = makeOnDone();
    await call(onDone, baseContext, "purple");
    expect(saveAgentColorMock).toHaveBeenCalledWith(
      "session-color-1",
      "purple",
      "/tmp/transcript.jsonl",
    );
    expect(calls[0].message).toContain("Session color set to: purple");
  });

  it("an invalid color name is rejected with the available-list", async () => {
    const { onDone, calls } = makeOnDone();
    await call(onDone, baseContext, "chartreuse");
    expect(calls[0].message).toContain('Invalid color "chartreuse"');
    expect(calls[0].message).toContain("red");
    expect(saveAgentColorMock).not.toHaveBeenCalled();
  });
});
