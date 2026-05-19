import { describe, expect, it } from "vitest";
import { formatRuntimeStats, statsCommand } from "./stats.js";
import type { Session } from "../session/session.js";

function stubSession(opts: {
  conversationId?: string;
  history?: unknown[];
  toolCount?: number;
  connectedServers?: string[];
}): Session {
  return {
    conversationId: opts.conversationId ?? "session-abc1",
    state: {
      unsafePeek: () => ({
        history: opts.history ?? [],
      }),
    },
    services: {
      registry: {
        tools: new Array(opts.toolCount ?? 0).fill({}),
      },
      mcpManager: {
        getConnectedServers: () => opts.connectedServers ?? [],
      },
    },
  } as unknown as Session;
}

describe("statsCommand", () => {
  it("renders all expected fields with zero state", () => {
    const text = formatRuntimeStats(stubSession({}), "/tmp/ws");
    expect(text).toContain("AgenC stats");
    expect(text).toContain("session: session-abc1");
    expect(text).toContain("cwd: /tmp/ws");
    expect(text).toContain("transcript items: 0");
    expect(text).toContain("registered tools: 0");
    expect(text).toContain("connected MCP servers: 0");
  });

  it("renders populated state correctly", () => {
    const text = formatRuntimeStats(
      stubSession({
        conversationId: "session-feed",
        history: [{}, {}, {}],
        toolCount: 17,
        connectedServers: ["alpha", "beta"],
      }),
      "/home/tester/proj",
    );
    expect(text).toContain("session: session-feed");
    expect(text).toContain("cwd: /home/tester/proj");
    expect(text).toContain("transcript items: 3");
    expect(text).toContain("registered tools: 17");
    expect(text).toContain("connected MCP servers: 2");
  });

  it("falls back gracefully when getConnectedServers is missing", () => {
    const session = {
      conversationId: "x",
      state: { unsafePeek: () => ({ history: [] }) },
      services: { registry: { tools: [] }, mcpManager: {} },
    } as unknown as Session;
    const text = formatRuntimeStats(session, "/tmp");
    expect(text).toContain("connected MCP servers: n/a (daemon-owned)");
  });

  it("execute() returns a text result", async () => {
    const result = await statsCommand.execute({
      session: stubSession({}),
      argsRaw: "",
      cwd: "/tmp/ws",
      home: "/tmp/home",
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("AgenC stats");
    }
  });
});
