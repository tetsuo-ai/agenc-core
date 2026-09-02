import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AdmissionAcquireInput,
  ExecutionAdmissionClient,
} from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import { getProjectRoot, setProjectRoot } from "../../src/bootstrap/state.js";
import { ConfigStore } from "../../src/config/store.js";
import { createAdmittedMemorySelector } from "../../src/memory/admitted-selector.js";
import { closeFullCorpusMemoryIndexes } from "../../src/memory/find-relevant.js";
import { getProjectMemoryPath } from "../../src/memory/paths.js";
import {
  enterCanonicalSettingsAuthority,
  resetCanonicalSettingsAuthorityForTesting,
} from "../../src/utils/settings/canonicalAuthority.js";
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
let previousProjectRoot = "";

afterEach(async () => {
  closeFullCorpusMemoryIndexes();
  setProjectRoot(previousProjectRoot);
  resetCanonicalSettingsAuthorityForTesting();
  getProjectMemoryPath.cache?.clear?.();
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
    previousProjectRoot = getProjectRoot();
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3a-production-"));
    const agencHome = join(temporaryRoot, "home");
    const cwd = join(temporaryRoot, "workspace");
    await mkdir(join(agencHome, "memory"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    process.env.AGENC_HOME = agencHome;
    setProjectRoot(cwd);
    enterCanonicalSettingsAuthority(
      new ConfigStore({
        home: agencHome,
        env: { ...process.env, AGENC_HOME: agencHome },
        cwd,
      }),
    );
    getProjectMemoryPath.cache?.clear?.();
    await mkdir(getProjectMemoryPath(), { recursive: true });
    const memoryPath = join(agencHome, "memory", "browser.md");
    await writeFile(
      memoryPath,
      "---\nname: Browser warning\ndescription: uniquebrowserfailure recovery\ntype: user\n---\nUse the safe browser recovery sequence.\n",
    );
    // More matches than the five-memory attachment limit, so the admitted
    // selector is consulted instead of the lexical shortcut.
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        writeFile(
          join(agencHome, "memory", `browser-variant-${index}.md`),
          `---\nname: Browser variant ${index}\ndescription: uniquebrowserfailure variant ${index}\ntype: user\n---\nVariant.\n`,
        ),
      ),
    );
    await Promise.all(
      Array.from({ length: 220 }, (_, index) =>
        writeFile(
          join(agencHome, "memory", `recent-${index}.md`),
          `---\nname: Recent ${index}\ndescription: unrelated compiler note\ntype: user\n---\nRecent.\n`,
        ),
      ),
    );

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
        messages: LLMMessage[],
        _options?: LLMChatOptions,
      ): Promise<LLMResponse> => {
        // The selector request is the JSON-serialized candidate list; pick
        // the "Browser warning" memory by title like a model would.
        const request = JSON.parse(String(messages[0]?.content)) as {
          candidates: ReadonlyArray<{ id: string; title: string }>;
        };
        const chosen = request.candidates.find(
          (candidate) => candidate.title === "Browser warning",
        );
        const selected = chosen === undefined ? [] : [chosen.id];
        return {
        content: JSON.stringify({ selected_candidate_ids: selected }),
        structuredOutput: {
          type: "json_schema",
          parsed: { selected_candidate_ids: selected },
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
        };
      },
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
