import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { QwenProvider } from "../../src/llm/providers/qwen/index.js";
import type { Session } from "../../src/session/session.js";

test.each(["qwen3-next-80b-a3b-thinking", "qwen3-32b", "ZHIPU/GLM-5.3", "kimi/kimi-k3"])(
  "hard budgets reject %s before dispatch without a verified total output cap", async model => {
    const directory = mkdtempSync(join(tmpdir(), "agenc-qwen-admission-"));
    const workspace = join(directory, "workspace");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    const kernel = new ExecutionAdmissionKernel({
      agencHome: join(directory, "home"), ownerId: "qwen-output-admission", ownerPid: process.pid,
      limits: { global: 1, workspace: 1, session: 1, parent: 1, provider: 1 },
    });
    const client = kernel.bindClient({ cwd: workspace,
      scope: { runId: "qwen-output", sessionId: "qwen-output", autonomous: false, maxCostUsd: 10 },
    });
    const invoke = vi.fn();
    const provider = new QwenProvider({ model: "glm-5.3", apiKey: "fixture", fetchImpl: vi.fn() });
    const session = { conversationId: "qwen-output",
      services: { executionAdmission: client, admissionRequired: true, agentControl: {} },
      abortTerminal: vi.fn(),
    } as unknown as Session;
    try {
      // The request override must decide the contract, not the default model.
      expect(await provider.getExecutionProfile({ model })).toMatchObject({ model, supportsMaxOutputTokens: false });
      await expect(runAdmittedModelCall({ session, provider, messages: [{ role: "user", content: "Hello" }],
        stepId: "output", model, providerName: "qwen",
        options: { model, maxOutputTokens: 128, contextWindowTokens: 131_072 }, invoke,
      })).rejects.toThrow(/provider_budget_contract_unavailable/);
      expect(invoke).not.toHaveBeenCalled();
      expect(await provider.getExecutionProfile({ model: "glm-5.3" })).toMatchObject({ supportsMaxOutputTokens: true });
      expect(await provider.getExecutionProfile({ model: "qwen-max" })).toMatchObject({ supportsMaxOutputTokens: true });
    } finally {
      await provider.dispose?.();
      kernel.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
