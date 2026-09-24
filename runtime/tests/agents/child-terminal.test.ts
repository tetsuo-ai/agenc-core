import { describe, expect, it, vi } from "vitest";
import { LLMManagedAdmissionError, LLMMessageValidationError } from "../../src/llm/errors.js";
import { AgentStatusTracker, formatSubagentNotification } from "../../src/agents/status.js";
import { toListedAgentJson } from "../../src/agents/v2/common.js";
import { isCanonicalEventPayload } from "../../src/state/recovery-journal-schema.js";
import { createWaitAgentTool } from "../../src/agents/v2/wait.js";
import type { MultiAgentV2Options } from "../../src/agents/v2/common.js";
import type { Session } from "../../src/session/session.js";

describe("child terminal failures", () => {
  const reasons = ["completed", "insufficient_funds", "rate_limited", "provider_unavailable",
    "timeout", "auth_required", "model_unavailable", "context_insufficient",
    "tool_protocol_unreliable", "model_refused", "parent_cancelled", "policy_revoked",
    "resume_blocked", "cost_cap_reached", "effect_outcome_unknown", "consent_denied",
    "consent_unavailable"] as const;

  it.each(reasons)("carries %s through spawn receipt, mailbox, wait, status, and journal", async (reason) => {
    const { childTerminalOutcome } = await import("../../src/agents/child-terminal.js");
    const terminal = childTerminalOutcome({ provider: "deepseek", model: "deepseek-chat",
      reason, dispatch: reason === "consent_denied" || reason === "consent_unavailable" ? "not_sent" : "sent",
      completedWork: "Read two files", unfinishedWork: reason === "completed" ? "" : "Run tests", costUsd: 0.02 });
    const status = new AgentStatusTracker();
    status.markErrored("turn", reason, terminal);
    expect(toListedAgentJson({ agentName: "/root/child", agentStatus: status.value }).terminal).toEqual(terminal);
    const notification = formatSubagentNotification({ agentPath: "/root/child", status: status.value,
      receipt: { lifecycle: "turn", outcome: "errored", turn_id: "turn", tool_call_count: 2, terminal } });
    expect(JSON.parse(notification.slice("<subagent_notification>\n".length,
      -"\n</subagent_notification>".length)).receipt.terminal).toEqual(terminal);
    const session = { conversationId: "root-session", activeTurn: { unsafePeek: () => ({ turnId: "turn" }) },
      emit: vi.fn(), nextInternalSubId: () => "sub-1", waitForMailboxChange: vi.fn(async () => true),
      drainPendingInputMessages: () => [{ role: "user", content: notification }],
      config: { multiAgentV2: {} }, } as unknown as Session;
    const wait = createWaitAgentTool({ getSession: () => session,
      ensureAgentControl: () => ({ control: { registerSessionRoot: vi.fn(), listAgents: () => [] }, registry: {} }),
    } as unknown as MultiAgentV2Options);
    const waited = await wait.execute({}, {} as never);
    expect(JSON.parse(waited.content).updates[0].content).toContain(`"reason":"${reason}"`);
    expect(isCanonicalEventPayload("collab_agent_spawn_end", { callId: "spawn", senderThreadId: "root",
      prompt: "Run tests", taskName: "child", model: terminal.model, provider: terminal.provider,
      terminal, status: status.value })).toBe(true);
    expect(isCanonicalEventPayload("subagent_turn_outcome", { agentId: "child", agentPath: "/root/child",
      turnId: "turn", outcome: "errored", toolCallCount: 2, terminal })).toBe(true);
    expect(isCanonicalEventPayload("collab_agent_status", { callId: "spawn", senderThreadId: "root",
      threadId: "child", status: status.value, terminal })).toBe(true);
  });

  it("lists a string status without inventing a terminal outcome", () => {
    expect(toListedAgentJson({ agentName: "/root/child", agentStatus: "running" as never }))
      .toEqual({ agent_name: "/root/child", agent_status: "running" });
  });
  const funds: readonly [string, unknown][] = [
    // DeepSeek error-codes documentation: HTTP 402, "Insufficient Balance".
    ["deepseek", { status: 402, error: { message: "Insufficient Balance" } }],
    // OpenAI API error body: insufficient_quota is a 429 billing refusal.
    ["openai", { status: 429, error: { code: "insufficient_quota", type: "insufficient_quota" } }],
    // Codex/ChatGPT subscription backend usage limit.
    ["openai", { status: 429, error: { code: "usage_limit_reached", message: "You have reached your ChatGPT usage limit" } }],
    // Anthropic API billing error text.
    ["anthropic", { status: 400, error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API" } }],
    // xAI #2483 billing refusal.
    ["grok", { status: 403, code: "personal-team-blocked:spending-limit", error: "You have run out of credits or need a Grok subscription." }],
    // OpenRouter HTTP 402 insufficient credits.
    ["openrouter", { status: 402, error: { message: "This request requires more credits" } }],
    // Gemini quota details distinguish exhausted billing quota from request rate.
    ["gemini", { status: 429, error: { status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateContentInputTokensPerModelPerDay-FreeTier" }] }] } }],
    // Managed AgenC admission response.
    ["agenc", { status: 402, error: { code: "insufficient_credits" } }],
  ];

  it.each(funds)("classifies %s funds fixture", async (provider, error) => {
    const { classifyChildFailure } = await import("../../src/agents/child-terminal.js");
    expect(classifyChildFailure(provider, error).reason).toBe("insufficient_funds");
    expect(classifyChildFailure(provider, error).retryable).toBe(false);
  });

  it("keeps a subscription limit's provider reset time on insufficient_funds", async () => {
    const { childTerminalOutcome } = await import("../../src/agents/child-terminal.js");
    expect(childTerminalOutcome({ provider: "openai", model: "gpt-6-luna", dispatch: "sent",
      error: { status: 429, body: { error: { code: "usage_limit_reached" } },
        headers: { "retry-after": "37" } } })).toMatchObject({
      reason: "insufficient_funds", retryable: false, retryAfterMs: 37_000,
    });
  });

  it.each([
    ["openai", { status: 429, error: { code: "rate_limit_exceeded" }, headers: { "retry-after": "2" } }],
    ["gemini", { status: 429, error: { status: "RESOURCE_EXHAUSTED", message: "Requests per minute exceeded" }, headers: { "retry-after": "2" } }],
    ["grok", { status: 429, error: { code: "rate_limit_exceeded" }, headers: { "retry-after": "2" } }],
  ] as const)("keeps %s request throttling retryable", async (provider, error) => {
    const { classifyChildFailure } = await import("../../src/agents/child-terminal.js");
    expect(classifyChildFailure(provider, error)).toMatchObject({ reason: "rate_limited", retryable: true, retryAfterMs: 2000 });
  });

  it.each([
    ["provider_unavailable", { status: 503 }],
    ["timeout", new Error("deadline_reached")],
    ["auth_required", { status: 401 }],
    ["model_unavailable", { status: 404 }],
    ["context_insufficient", { status: 413 }],
    ["tool_protocol_unreliable", new Error("invalid tool protocol")],
    ["model_refused", new Error("content_filter")],
    ["parent_cancelled", new Error("cancelled")],
    ["policy_revoked", new Error("policy_revoked")],
    ["resume_blocked", new Error("resume_blocked")],
    ["cost_cap_reached", new Error("max_budget_usd")],
    ["effect_outcome_unknown", new Error("tool effect has unknown outcome")],
  ] as const)("maps existing %s failure path", async (reason, error) => {
    const { classifyChildFailure } = await import("../../src/agents/child-terminal.js");
    expect(classifyChildFailure("openai", error).reason).toBe(reason);
  });

  it("preserves progress and dispatch certainty in the one terminal contract", async () => {
    const { childTerminalOutcome } = await import("../../src/agents/child-terminal.js");
    expect(childTerminalOutcome({ provider: "deepseek", model: "deepseek-chat", error: { status: 402 }, completedWork: "Wrote the parser", unfinishedWork: "Run tests", dispatch: "sent", costUsd: 0.01 })).toMatchObject({
      provider: "deepseek", model: "deepseek-chat", reason: "insufficient_funds", retryable: false,
      dispatch: "sent", completedWork: "Wrote the parser", unfinishedWork: "Run tests", costUsd: 0.01,
    });
  });

  it("distinguishes pre-dispatch rejection, provider response, and unknown transport", async () => {
    const { childDispatchCertainty } = await import("../../src/agents/child-terminal.js");
    expect(childDispatchCertainty(new LLMManagedAdmissionError("insufficient_credits"))).toBe("not_sent");
    expect(childDispatchCertainty(new LLMMessageValidationError("openai", {
      validationCode: "orphan_tool_result", messageIndex: 2, reason: "unmatched result",
    }))).toBe("not_sent");
    expect(childDispatchCertainty({ status: 402, error: { message: "Insufficient Balance" } })).toBe("sent");
    expect(childDispatchCertainty(new Error("fetch failed"))).toBe("unknown");
  });
});
