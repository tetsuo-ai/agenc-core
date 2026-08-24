import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AdmissionAcquireInput,
  ExecutionAdmissionClient,
} from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import { createAdmittedMemorySelector } from "../../src/memory/admitted-selector.js";
import { closeFullCorpusMemoryIndexes } from "../../src/memory/find-relevant.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
} from "../../src/llm/types.js";
import { getAttachmentTrackingState } from "../../src/session/attachment-state.js";
import type { Session } from "../../src/session/session.js";
import { relevantMemoriesProducer } from "../../src/prompts/attachments/relevant-memories.js";

let temporaryRoot = "";
let previousAgenCHome: string | undefined;

afterEach(async () => {
  closeFullCorpusMemoryIndexes();
  if (previousAgenCHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousAgenCHome;
  if (temporaryRoot !== "") {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = "";
  }
});

describe("C3b production memory recall wiring", () => {
  it("runs full-corpus recall older than 200 through admission and a provider", async () => {
    previousAgenCHome = process.env.AGENC_HOME;
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-production-"));
    const agencHome = join(temporaryRoot, "home");
    const cwd = join(temporaryRoot, "workspace");
    await mkdir(join(agencHome, "memory"), { recursive: true });
    await mkdir(join(cwd, ".agenc", "memory"), { recursive: true });
    const memoryPath = join(agencHome, "memory", "browser.md");
    await writeFile(
      memoryPath,
      "---\nname: Browser warning\ndescription: uniquebrowserfailure recovery\ntype: user\n---\nUse the safe browser recovery sequence.\n",
    );
    await Promise.all(
      Array.from({ length: 220 }, (_, index) =>
        writeFile(
          join(agencHome, "memory", `recent-${index}.md`),
          `---\nname: Recent ${index}\ndescription: unrelated compiler note\ntype: user\n---\nRecent.\n`,
        ),
      ),
    );
    process.env.AGENC_HOME = agencHome;

    const acquire = vi.fn(
      async (input: AdmissionAcquireInput): Promise<AdmissionLease> => ({
        decision: "allow",
        reservation: {
          reservationId: "memory-reservation",
          step: { runId: "run", stepId: input.stepId },
          reservedCostUsd: input.maxCostUsd ?? 0,
          reservedTokens: input.maxInputTokens + input.maxOutputTokens,
          reservedAt: "2026-08-03T00:00:00.000Z",
        },
        request: {
          step: { runId: "run", stepId: input.stepId },
          kind: input.kind,
          estimate: {
            maxInputTokens: input.maxInputTokens,
            maxOutputTokens: input.maxOutputTokens,
            maxCostUsd: input.maxCostUsd,
          },
          workspaceId: "workspace",
          sessionId: "session",
          parentScopeId: "memory-selector",
          autonomous: false,
        },
        signal: new AbortController().signal,
      }),
    );
    const admission = {
      scope: {
        runId: "run",
        workspaceId: "workspace",
        sessionId: "session",
        autonomous: false,
      },
      acquire,
      markDispatched: vi.fn(),
      reconcile: vi.fn(() => ({ applied: true, outcome: "reconciled" })),
      holdUnknown: vi.fn(),
      cancelRun: vi.fn(),
      void: vi.fn(),
      acknowledgeCompletion: vi.fn(),
      recordFallback: vi.fn(),
      forSession: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } as unknown as ExecutionAdmissionClient;
    const chat = vi.fn(
      async (
        _messages: LLMMessage[],
        _options?: LLMChatOptions,
      ): Promise<LLMResponse> => ({
        content: JSON.stringify({ selected_candidate_ids: ["candidate-1"] }),
        structuredOutput: {
          type: "json_schema",
          parsed: { selected_candidate_ids: ["candidate-1"] },
        },
        toolCalls: [],
        usage: {
          promptTokens: 80,
          completionTokens: 8,
          totalTokens: 88,
          availability: "reported",
          provenance: "provider",
        },
        model: "grok-4.5",
        finishReason: "stop",
      }),
    );
    const provider = {
      name: "grok",
      chat,
      getExecutionProfile: async () => ({
        usageReporting: "authoritative" as const,
        supportsMaxOutputTokens: true,
      }),
    } as unknown as LLMProvider;
    let subId = 0;
    const session = {
      conversationId: "session",
      modelInfo: {
        slug: "grok-4.5",
        contextWindow: 131_072,
      },
      services: {
        provider,
        executionAdmission: admission,
        admissionRequired: true,
        agentControl: { shutdownAgentTree: vi.fn() },
      },
      nextInternalSubId: () => String(subId++),
      abortTerminal: vi.fn(),
    } as unknown as Session;
    const sessionKey = {};

    const attachments = await relevantMemoriesProducer(
      {
        sessionKey,
        userInput: "uniquebrowserfailure",
        loadedTools: [],
        messages: [],
        permissionContext: { mode: "default" } as never,
        cwd,
        subagentDepth: 0,
        signal: new AbortController().signal,
        agencHome,
        admittedMemorySelector: createAdmittedMemorySelector(session),
      },
      getAttachmentTrackingState(sessionKey),
    );

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire.mock.calls[0]?.[0].stepId).toBe("memory-selector:0");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]?.[0][0]?.content).toContain("Browser warning");
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      kind: "relevant_memories",
      memories: [{ path: memoryPath, selectionSource: "reranked" }],
    });
  });
});
