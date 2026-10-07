import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { isLLMPreGenerationRejection } from "../../src/llm/errors.js";
import { BedrockProvider } from "../../src/llm/providers/bedrock/index.js";
import type { LLMMessage } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";

test.each([
  ["chat", false], ["chatStream", false],
  ["chat", true], ["chatStream", true],
] as const)("Bedrock Haiku %s settles only proven initial refusals (accepted=%s)", async (method, accepted) => {
  const directory = mkdtempSync(join(tmpdir(), "agenc-bedrock-haiku-refusal-"));
  const workspace = join(directory, "workspace");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  const kernel = new ExecutionAdmissionKernel({
    agencHome: join(directory, "home"), ownerId: "bedrock-haiku-refusal", ownerPid: process.pid,
    limits: { global: 1, workspace: 1, session: 1, parent: 1, provider: 1 },
  });
  const client = kernel.bindClient({
    cwd: workspace,
    scope: { runId: "bedrock-haiku", sessionId: "bedrock-haiku", autonomous: false, maxCostUsd: 10 },
  });
  const hold = vi.spyOn(client, "holdUnknown");
  const reconcile = vi.spyOn(client, "reconcile");
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => accepted
    ? new Response(new ReadableStream({
      pull(controller) { controller.error(Object.assign(new Error("accepted body failed"), { status: 429 })); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } })
    : Response.json({ error: { type: "rate_limit_error", message: "initial refusal" } }, { status: 429 }));
  const model = "anthropic.claude-haiku-5-5";
  const provider = new BedrockProvider({ model, accessKeyId: "test-id", secretAccessKey: "test-secret", fetchImpl });
  const messages: LLMMessage[] = [{ role: "user", content: "synthetic probe" }];
  const session = {
    conversationId: "bedrock-haiku",
    services: { executionAdmission: client, admissionRequired: true, agentControl: {} },
    abortTerminal: vi.fn(),
  } as unknown as Session;
  try {
    const error = await runAdmittedModelCall({
      session, provider, messages, stepId: "refusal", model, providerName: provider.name,
      options: { maxOutputTokens: 100, contextWindowTokens: 4096 },
      invoke: options => {
        expect(options.singleWireAttempt).toBe(true);
        return method === "chat" ? provider.chat(messages, options) : provider.chatStream(messages, () => {}, options);
      },
    }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(isLLMPreGenerationRejection(error, provider.name)).toBe(!accepted);
    expect(isLLMPreGenerationRejection(error, "anthropic")).toBe(false);
    if (accepted) {
      expect(reconcile).not.toHaveBeenCalled();
      expect(hold).toHaveBeenCalledExactlyOnceWith(expect.any(String), "provider_call_failed_after_dispatch");
    } else {
      expect(hold).not.toHaveBeenCalled();
      expect(reconcile).toHaveBeenCalledExactlyOnceWith(expect.any(String), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    }
    expect(client.getUsageSummary?.()).toMatchObject({ hasUnknownCost: accepted });
    expect(kernel.activeCount).toBe(0);
    expect(kernel.queuedCount).toBe(0);
  } finally {
    kernel.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
