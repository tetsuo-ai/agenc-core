import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { ClaudeSubscriptionProvider } from "./provider.js";
import type { LLMMessage, LLMTool } from "../../src/llm/types.js";

const provider = new ClaudeSubscriptionProvider(process.env.AGENC_CLAUDE_MODEL ?? "sonnet");
try {
  const status = await provider.status();
  console.log(JSON.stringify({ type: "auth", ...status }));
  if (process.argv.includes("--status")) process.exitCode = status.loggedIn && status.subscription ? 0 : 2;
  else {
    assert(status.available && status.loggedIn && status.subscription, "Complete `claude auth login` first.");
    // The model cannot know this nonce until the host executes its tool.
    const nonce = randomUUID();
    const tools: LLMTool[] = [{ type: "function", function: { name: "system.subscription_probe",
      description: "Return the host's secret test nonce. Call exactly once with no arguments.",
      parameters: { type: "object", properties: {}, additionalProperties: false } } }];
    const history: LLMMessage[] = [{ role: "user", content: "Call system.subscription_probe once. After receiving its result, reply with exactly that nonce. Do not invent it." }];
    let executed = 0;
    let completed = false;
    const totals = { prompt: 0, completion: 0 };
    for (let round = 0; round < 3; round++) {
      const response = await provider.chatStream(history, (chunk) => {
        if (chunk.content) process.stdout.write(chunk.content);
      }, { tools, maxOutputTokens: 512, reasoningEffort: "none", singleWireAttempt: true, timeoutMs: 90_000 });
      totals.prompt += response.usage.promptTokens; totals.completion += response.usage.completionTokens;
      console.log("\n" + JSON.stringify({ type: "round", round, finish: response.finishReason, usage: response.usage, tools: response.toolCalls.map((t) => t.name) }));
      history.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls,
        providerReasoningContent: response.providerReasoningContent, providerReasoningProvenance: response.providerReasoningProvenance });
      if (response.toolCalls.length) {
        assert.equal(response.toolCalls.length, 1);
        const call = response.toolCalls[0]!;
        assert.equal(call.name, "system.subscription_probe");
        assert.deepEqual(JSON.parse(call.arguments), {});
        assert.equal(executed++, 0, "Repeated tool execution refused");
        // This harmless fixture runs in the host, never in Claude Code.
        history.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: nonce });
      } else {
        assert.equal(executed, 1); assert.equal(response.finishReason, "stop");
        assert.equal(response.content.trim(), nonce); completed = true; break;
      }
    }
    assert(completed, "Probe exceeded its three-request limit");
    console.log(JSON.stringify({ type: "passed", hostToolExecutions: executed, tokens: totals }));
  }
} finally { provider.dispose(); }
