import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../../src/session/session.js";
import type { AgentStatus } from "../../../src/agents/status.js";
import type { MultiAgentV2Options } from "../../../src/agents/v2/common.js";
import { createSendMessageTool } from "../../../src/agents/v2/send-message.js";

function fixture(initialStatus: AgentStatus) {
  let status = initialStatus;
  const sendInterAgentCommunication = vi.fn(async () => {});
  const live = {
    agentId: "child-1",
    agentPath: "/root/child",
    nickname: "Child",
    role: { name: "default" },
  };
  const control = {
    registerSessionRoot: vi.fn(),
    getLive: vi.fn((id: string) => id === live.agentId ? live : undefined),
    getAgentMetadata: vi.fn(() => undefined),
    resolveAgentReference: vi.fn(() => live.agentId),
    getStatus: vi.fn(async () => status),
    sendInterAgentCommunication,
  };
  const session = {
    conversationId: "root-session",
    nextInternalSubId: () => "event-1",
    emit: vi.fn(),
  } as unknown as Session;
  const opts = {
    getSession: () => session,
    workspace: {},
    ensureAgentControl: () => ({ control, registry: {} }),
  } as unknown as MultiAgentV2Options;
  const tool = createSendMessageTool(opts);
  const send = async () => {
    const result = await tool.execute({ target: live.agentPath, message: "hello" });
    return { result, body: JSON.parse(result.content) as Record<string, unknown> };
  };
  return { send, sendInterAgentCommunication, setStatus: (next: AgentStatus) => { status = next; }, tool };
}

describe("send_message delivery report", () => {
  it("reports a running child's message as accepted but unconfirmed", async () => {
    const f = fixture({ status: "running", turnId: "turn-1", startedAtMs: 1 });
    const { result, body } = await f.send();
    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({
      ok: true,
      delivered: false,
      delivery: "accepted_unconfirmed",
      status: { status: "running" },
    });
    expect(body.hint).toContain("If this turn ends first");
    expect(f.sendInterAgentCommunication).toHaveBeenCalledOnce();
    expect(f.tool.description).toContain("Does not trigger a new turn");
  });

  it.each([
    { status: "idle", turnId: "turn-1", endedAtMs: 2 },
    { status: "completed", turnId: "turn-1", endedAtMs: 2 },
    { status: "errored", turnId: "turn-1", endedAtMs: 2, error: "failed" },
  ] as AgentStatus[])("returns an undelivered result for $status", async (status) => {
    const f = fixture(status);
    const { result, body } = await f.send();
    expect(result.isError).toBe(true);
    expect(result.effectDisposition).toMatchObject({ disposition: "confirmed_no_effect" });
    expect(body).toMatchObject({ ok: false, delivered: false, status });
    expect(body.hint).toContain("assign_task");
    expect(f.sendInterAgentCommunication).not.toHaveBeenCalled();
  });
});
