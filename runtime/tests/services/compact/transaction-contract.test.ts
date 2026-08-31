import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalCompactionSourceMessages,
} from "../../../src/services/compact/plan.js";
import {
  accumulateCompactionOutputBudget,
  compactionOutputTokenUpperBound,
  compactionWallTimeExceeded,
} from "../../../src/services/compact/transaction-limits.js";
import {
  canonicalizeJson,
  createCompactionSummaryV1,
  digestWithDomain,
  parseCompactionBodyV1,
  verifyCompactionSummaryDigest,
} from "../../../src/services/compact/summary-v1.js";
import { compactConversationTransactionally } from "../../../src/services/compact/transaction.js";
import {
  MAX_COMPACTION_INTERMEDIATE_TOKENS,
  MAX_COMPACTION_OUTPUT_NODES_TOTAL,
  MAX_COMPACTION_OUTPUT_UTF8_BYTES_TOTAL,
  MAX_COMPACTION_FOCUS_UTF8_BYTES,
  MAX_COMPACTION_PAYLOAD_CANONICAL_UTF8_BYTES,
  MAX_COMPACTION_PROVIDER_CALLS,
  MAX_COMPACTION_REPLACEMENT_ENVELOPE_UTF8_BYTES,
  MAX_COMPACTION_REPLACEMENT_SUMMARY_UTF8_BYTES,
  MAX_COMPACTION_SCHEMA_WORK_UNITS_PER_OUTPUT,
  MAX_COMPACTION_WALL_MS,
  COMPACTION_CONFIGURATION_DIGEST_DOMAIN,
  type CompactionTransactionAdapter,
} from "../../../src/services/compact/transaction-types.js";
import type {
  CompactContext,
  RuntimeMessage,
} from "../../../src/services/compact/types.js";
import { getCompactPrompt } from "../../../src/services/compact/prompt.js";
import { RolloutStore } from "../../../src/session/rollout-store.js";
import { reduceAll } from "../../../src/session/event-log-reducer.js";
import { readCompactionRolloutPayload } from "../../../src/session/compaction-event-reader.js";
import type { RolloutItem } from "../../../src/session/rollout-item.js";
import type { Session } from "../../../src/session/session.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMTool,
} from "../../../src/llm/types.js";
import { ExecutionAdmissionKernel } from "../../../src/budget/execution-admission-kernel.js";
import { bindExecutionAdmissionJournal } from "../../../src/session/execution-admission-journal.js";
import type { Event } from "../../../src/session/event-log.js";

const DIGEST = "a".repeat(64);
const BODY = {
  narrative: "A bounded account of the conversation.",
  facts: [{ id: "fact-1", text: "One fact", source_ref_ids: ["source-1"] }],
  open_actions: [],
  tool_pairs: [],
} as const;
const SESSION_CWD = "/test/compaction-workspace";
const SESSION_MODEL = "grok-4.5";
const SESSION_PERMISSION_MODE = "default";

type TestCompactionHooks = {
  readonly executePreCompact: (
    input: Readonly<Record<string, unknown>>,
    options?: unknown,
  ) => Promise<unknown>;
  readonly executePostCompact: (
    input: Readonly<Record<string, unknown>>,
    options?: unknown,
  ) => Promise<unknown>;
};

type TransactionRunOverrides = Pick<
  CompactContext,
  "abortController" | "compactionTransaction" | "deps"
> & {
  readonly automatic?: boolean;
  readonly customInstructions?: string;
  readonly hooks?: TestCompactionHooks;
};

describe("transactional compaction strict contracts", () => {
  it("never authorizes instructions embedded in transcript context", () => {
    expect(getCompactPrompt()).not.toContain(
      "There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions",
    );
  });

  it("accepts exact aggregate output limits and rejects each plus one", () => {
    const maximumWorkUnits =
      MAX_COMPACTION_SCHEMA_WORK_UNITS_PER_OUTPUT * MAX_COMPACTION_PROVIDER_CALLS;
    const exact = accumulateCompactionOutputBudget(
      { bytes: 0, nodes: 0, workUnits: 0 },
      {
        bytes: MAX_COMPACTION_OUTPUT_UTF8_BYTES_TOTAL,
        nodes: MAX_COMPACTION_OUTPUT_NODES_TOTAL,
        workUnits: maximumWorkUnits,
      },
    );
    expect(exact).toEqual({
      bytes: MAX_COMPACTION_OUTPUT_UTF8_BYTES_TOTAL,
      nodes: MAX_COMPACTION_OUTPUT_NODES_TOTAL,
      workUnits: maximumWorkUnits,
    });
    for (const delta of [
      { bytes: 1, nodes: 0, workUnits: 0 },
      { bytes: 0, nodes: 1, workUnits: 0 },
      { bytes: 0, nodes: 0, workUnits: 1 },
    ]) {
      expect(() => accumulateCompactionOutputBudget(exact, delta))
        .toThrow(/aggregate limit/i);
    }
  });

  it("uses reported output tokens and a fail-closed UTF-8 upper bound", () => {
    expect(
      compactionOutputTokenUpperBound(
        "x".repeat(MAX_COMPACTION_INTERMEDIATE_TOKENS + 1),
        undefined,
      ),
    ).toBe(MAX_COMPACTION_INTERMEDIATE_TOKENS + 1);
    expect(
      compactionOutputTokenUpperBound(
        "large response",
        MAX_COMPACTION_INTERMEDIATE_TOKENS,
      ),
    ).toBe(MAX_COMPACTION_INTERMEDIATE_TOKENS);
    expect(
      compactionOutputTokenUpperBound(
        "small",
        MAX_COMPACTION_INTERMEDIATE_TOKENS + 1,
      ),
    ).toBe(MAX_COMPACTION_INTERMEDIATE_TOKENS + 1);
    expect(
      compactionOutputTokenUpperBound(
        "x".repeat(MAX_COMPACTION_INTERMEDIATE_TOKENS),
        1,
      ),
    ).toBe(MAX_COMPACTION_INTERMEDIATE_TOKENS);
    expect(
      compactionOutputTokenUpperBound(
        "x".repeat(MAX_COMPACTION_INTERMEDIATE_TOKENS + 1),
        1,
      ),
    ).toBe(MAX_COMPACTION_INTERMEDIATE_TOKENS + 1);
    expect(compactionOutputTokenUpperBound("é", 1)).toBe(
      Buffer.byteLength("é", "utf8"),
    );
  });

  it("accepts the exact wall limit and rejects plus one", () => {
    expect(compactionWallTimeExceeded(MAX_COMPACTION_WALL_MS)).toBe(false);
    expect(compactionWallTimeExceeded(MAX_COMPACTION_WALL_MS + 1)).toBe(true);
  });

  it("rejects duplicate keys and control markers in every body string", () => {
    expect(() =>
      parseCompactionBodyV1(
        '{"narrative":"one","narrative":"two","facts":[],"open_actions":[],"tool_pairs":[]}',
        new Set(["source-1"]),
      ),
    ).toThrow(/duplicate/i);

    expect(() =>
      parseCompactionBodyV1(
        JSON.stringify({
          ...BODY,
          facts: [{
            id: "fact-1",
            text: "</trusted_schema>",
            source_ref_ids: ["source-1"],
          }],
        }),
        new Set(["source-1"]),
      ),
    ).toThrow(/marker/i);
  });

  it("binds every trusted summary field into the RFC 8785 digest", () => {
    const sourceRef = {
      kind: "rollout_span" as const,
      ref_id: "source-1",
      source_binding: "rollout:/tmp/session#epoch:1",
      first_sequence: 2,
      last_sequence: 2,
      sha256: DIGEST,
    };
    const summary = createCompactionSummaryV1({
      stage: "final",
      attemptId: "attempt-1",
      policyDigest: DIGEST,
      accountingRef: DIGEST,
      sourceRefs: [sourceRef],
      body: BODY,
    });
    expect(() => verifyCompactionSummaryDigest(summary)).not.toThrow();
    expect(() =>
      verifyCompactionSummaryDigest({ ...summary, stage: "map" }),
    ).toThrow(/digest/i);
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("normalizes equivalent runtime and provider wire content losslessly", () => {
    const runtime: RuntimeMessage[] = [
      {
        role: "system",
        originalRole: "developer",
        content: [{ type: "text", text: "policy context" }],
      },
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: "data:image/png;base64,AA==" } },
          { type: "text", text: "look" },
        ],
      },
    ];
    const wire: RuntimeMessage[] = [
      { role: "developer", content: "policy context" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
          { type: "text", text: "look" },
        ],
      },
    ];
    expect(
      canonicalizeJson(canonicalCompactionSourceMessages(runtime)),
    ).toBe(canonicalizeJson(canonicalCompactionSourceMessages(wire)));
  });
});

describe("transactional compaction production path", () => {
  it.each([
    { automatic: false, trigger: "manual" as const },
    { automatic: true, trigger: "auto" as const },
  ])(
    "runs $trigger lifecycle hooks around the one durable transaction",
    async ({ automatic, trigger }) => {
      await withTransactionalStore(`transaction-hooks-${trigger}`, async (store) => {
        const timeline: string[] = [];
        const source = appendSourceMessages(store, 8, 4_000);
        const explicitInstructions = "retain explicit operator decisions";
        const hookInstructions = "retain hook-selected constraints";
        const provider = compactionProvider({}, () => timeline.push("provider"));
        const adapter = observingTransactionAdapter(store, timeline);
        let preInput: Readonly<Record<string, unknown>> | undefined;
        let postInput: Readonly<Record<string, unknown>> | undefined;
        let postObservedCommitted = false;
        const hooks: TestCompactionHooks = {
          executePreCompact: vi.fn(async (input) => {
            timeline.push("pre");
            preInput = input;
            return { newCustomInstructions: hookInstructions };
          }),
          executePostCompact: vi.fn(async (input) => {
            timeline.push("post");
            postInput = input;
            postObservedCommitted = store.readAll()
              .filter(isCompactionLifecycleItem)
              .at(-1)?.type === "compaction_committed";
            return {};
          }),
        };

        const result = await runRealTransaction(store, source, provider, {
          automatic,
          customInstructions: explicitInstructions,
          hooks,
          compactionTransaction: adapter,
        });

        expect(timeline).toEqual(["pre", "intent", "provider", "commit", "post"]);
        expect(provider.chat).toHaveBeenCalledWith(
          expect.any(Array),
          expect.objectContaining({
            tools: [],
            toolRouting: { allowedToolNames: [] },
          }),
        );
        expect(hooks.executePreCompact).toHaveBeenCalledOnce();
        expect(hooks.executePostCompact).toHaveBeenCalledOnce();
        expect(preInput).toEqual({
          hook_event_name: "PreCompact",
          trigger,
          custom_instructions: explicitInstructions,
          session_id: store.sessionId,
          transcript_path: store.rolloutPath,
          cwd: SESSION_CWD,
          permission_mode: SESSION_PERMISSION_MODE,
        });

        const mergedInstructions = `${explicitInstructions}\n\n${hookInstructions}`;
        expect(providerCoveragePriority(provider)).toBe(mergedInstructions);
        expect(result.transaction?.configuration_digest).toBe(
          digestWithDomain(COMPACTION_CONFIGURATION_DIGEST_DOMAIN, {
            model: SESSION_MODEL,
            provider: "grok",
            context_window_tokens: 64_000,
            max_output_tokens: 512,
            direction: "from",
            requested_focus: mergedInstructions,
          }),
        );

        const persistedSummary = result.transaction?.committed.replacement_history
          .find((message) => message.compactionHistory?.kind === "summary")?.content;
        expect(typeof persistedSummary).toBe("string");
        expect(postObservedCommitted).toBe(true);
        expect(postInput).toEqual({
          hook_event_name: "PostCompact",
          trigger,
          compact_summary: persistedSummary,
          session_id: store.sessionId,
          transcript_path: store.rolloutPath,
          cwd: SESSION_CWD,
          permission_mode: SESSION_PERMISSION_MODE,
        });
      });
    },
  );

  it("preserves the exact separator when Pre adds focus to empty auto instructions", async () => {
    await withTransactionalStore("transaction-hooks-auto-empty-focus", async (store) => {
      const source = appendSourceMessages(store, 8, 4_000);
      const provider = compactionProvider();
      const hookInstructions = "retain hook-selected constraints";
      const pre = vi.fn(async () => ({
        newCustomInstructions: hookInstructions,
      }));
      const post = vi.fn(async () => ({}));

      const result = await runRealTransaction(store, source, provider, {
        automatic: true,
        customInstructions: "",
        hooks: {
          executePreCompact: pre,
          executePostCompact: post,
        },
      });

      const mergedInstructions = `\n\n${hookInstructions}`;
      expect(pre).toHaveBeenCalledOnce();
      expect(pre.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        trigger: "auto",
        custom_instructions: "",
      }));
      expect(providerCoveragePriority(provider)).toBe(mergedInstructions);
      expect(result.transaction?.configuration_digest).toBe(
        digestWithDomain(COMPACTION_CONFIGURATION_DIGEST_DOMAIN, {
          model: SESSION_MODEL,
          provider: "grok",
          context_window_tokens: 64_000,
          max_output_tokens: 512,
          direction: "from",
          requested_focus: mergedInstructions,
        }),
      );
      expect(post).toHaveBeenCalledOnce();
    });
  });

  it("does not inherit constructor-scoped session tools into admitted summaries", async () => {
    await withTransactionalStore("transaction-tool-free-factory-catalog", async (store) => {
      const factoryTools: readonly LLMTool[] = [
        {
          type: "function",
          function: {
            name: "session_catalog_tool",
            description: "x".repeat(300_000),
            parameters: { type: "object", properties: {} },
          },
        },
      ];
      const provider = compactionProvider({}, undefined, factoryTools, {
        remoteMcp: {
          enabled: true,
          servers: [
            {
              serverLabel: "remote",
              serverUrl: "https://mcp.example",
            },
          ],
        },
      });
      const source = appendSourceMessages(store, 8, 4_000);

      const result = await runRealTransaction(store, source, provider);

      expect(result.transaction).toBeDefined();
      expect(provider.chat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          tools: [],
          toolRouting: { allowedToolNames: [] },
        }),
      );
    });
  });

  it.each([
    {
      name: "failed hook result",
      pre: async () => ({ userDisplayMessage: "PreCompact hook failed" }),
    },
    {
      name: "throwing hook service",
      pre: async () => {
        throw new Error("injected pre-hook service failure");
      },
    },
  ])("keeps a $name nonfatal and out of provider focus", async ({ name, pre }) => {
    await withTransactionalStore(`transaction-pre-${name.replaceAll(" ", "-")}`, async (store) => {
      const source = appendSourceMessages(store, 8, 4_000);
      const provider = compactionProvider();
      const post = vi.fn(async () => ({}));
      const preHook = vi.fn(pre);

      const result = await runRealTransaction(store, source, provider, {
        customInstructions: "explicit only",
        hooks: {
          executePreCompact: preHook,
          executePostCompact: post,
        },
      });

      expect(result.transaction).toBeDefined();
      expect(preHook).toHaveBeenCalledOnce();
      expect(post).toHaveBeenCalledOnce();
      expect(providerCoveragePriority(provider)).toBe("explicit only");
      expect(store.readAll().filter(isCompactionLifecycleItem).map((item) => item.type))
        .toEqual(["compaction_intent", "compaction_committed"]);
    });
  });

  it("rejects oversized merged hook focus before intent or provider admission", async () => {
    await withTransactionalStore("transaction-merged-focus-limit", async (store) => {
      const timeline: string[] = [];
      const source = appendSourceMessages(store, 8, 4_000);
      const provider = compactionProvider({}, () => timeline.push("provider"));
      const post = vi.fn(async () => ({}));
      const adapter = observingTransactionAdapter(store, timeline);
      const pre = vi.fn(async () => {
        timeline.push("pre");
        return {
          newCustomInstructions: "x".repeat(MAX_COMPACTION_FOCUS_UTF8_BYTES),
        };
      });

      await expect(runRealTransaction(store, source, provider, {
        customInstructions: "explicit",
        hooks: {
          executePreCompact: pre,
          executePostCompact: post,
        },
        compactionTransaction: adapter,
      })).rejects.toThrow(/coverage priority exceeds/i);

      expect(timeline).toEqual(["pre"]);
      expect(pre).toHaveBeenCalledOnce();
      expect(post).not.toHaveBeenCalled();
      expect(provider.chat).not.toHaveBeenCalled();
      expect(store.readAll().some((item) => item.type.startsWith("compaction_")))
        .toBe(false);
    });
  });

  it("runs Pre once but never Post when the provider fails", async () => {
    await withTransactionalStore("transaction-provider-failure-hooks", async (store) => {
      const source = appendSourceMessages(store, 8, 4_000);
      const provider = compactionProvider({ finishReason: "length" });
      const pre = vi.fn(async () => ({}));
      const post = vi.fn(async () => ({}));

      await expect(runRealTransaction(store, source, provider, {
        hooks: {
          executePreCompact: pre,
          executePostCompact: post,
        },
      })).rejects.toThrow(/finish reason was length/i);

      expect(pre).toHaveBeenCalledOnce();
      expect(post).not.toHaveBeenCalled();
      expect(store.readAll().filter(isCompactionLifecycleItem)).toMatchObject([
        { type: "compaction_intent" },
        { type: "compaction_failed", payload: { reason: "provider_non_stop" } },
      ]);
    });
  });

  it("never runs Post when the durable commit fails", async () => {
    await withTransactionalStore("transaction-commit-failure-hooks", async (store) => {
      const source = appendSourceMessages(store, 8, 4_000);
      const provider = compactionProvider();
      const pre = vi.fn(async () => ({}));
      const post = vi.fn(async () => ({}));

      await expect(runRealTransaction(store, source, provider, {
        hooks: {
          executePreCompact: pre,
          executePostCompact: post,
        },
        compactionTransaction: failingCommitAdapter(store),
      })).rejects.toThrow(/durable compaction commit failed/i);

      expect(pre).toHaveBeenCalledOnce();
      expect(post).not.toHaveBeenCalled();
      expect(store.readAll().filter(isCompactionLifecycleItem)).toMatchObject([
        { type: "compaction_intent" },
        { type: "compaction_failed", payload: { reason: "commit_failed" } },
      ]);
    });
  });

  it("keeps a throwing Post service nonfatal after commit", async () => {
    await withTransactionalStore("transaction-post-service-failure", async (store) => {
      const source = appendSourceMessages(store, 8, 4_000);
      const provider = compactionProvider();
      const pre = vi.fn(async () => ({}));
      const post = vi.fn(async () => {
        throw new Error("injected post-hook service failure");
      });

      const result = await runRealTransaction(store, source, provider, {
        hooks: {
          executePreCompact: pre,
          executePostCompact: post,
        },
      });

      expect(result.transaction).toBeDefined();
      expect(pre).toHaveBeenCalledOnce();
      expect(post).toHaveBeenCalledOnce();
      expect(store.readAll().filter(isCompactionLifecycleItem).map((item) => item.type))
        .toEqual(["compaction_intent", "compaction_committed"]);
    });
  });

  it.each(["PreCompact", "PostCompact"] as const)(
    "releases the durable lease when an abort-ignoring %s hook is cancelled",
    async (event) => {
      await withTransactionalStore(`transaction-${event}-abort-lease`, async (store) => {
        const source = appendSourceMessages(store, 8, 4_000);
        const provider = compactionProvider();
        const abortController = new AbortController();
        let markHookStarted!: () => void;
        const hookStarted = new Promise<void>((resolve) => {
          markHookStarted = resolve;
        });
        const neverSettles = async (): Promise<Record<string, never>> => {
          markHookStarted();
          return new Promise<Record<string, never>>(() => {});
        };
        const hooks: TestCompactionHooks = {
          executePreCompact:
            event === "PreCompact" ? vi.fn(neverSettles) : vi.fn(async () => ({})),
          executePostCompact:
            event === "PostCompact" ? vi.fn(neverSettles) : vi.fn(async () => ({})),
        };

        const transaction = runRealTransaction(store, source, provider, {
          abortController,
          hooks,
        });
        await hookStarted;
        abortController.abort(new DOMException("test cancellation", "AbortError"));

        if (event === "PreCompact") {
          await expect(transaction).rejects.toMatchObject({ name: "AbortError" });
          expect(store.readAll().filter(isCompactionLifecycleItem)).toEqual([]);
        } else {
          const result = await transaction;
          expect(result.transaction).toBeDefined();
          expect(store.readAll().filter(isCompactionLifecycleItem).map((item) => item.type))
            .toEqual(["compaction_intent", "compaction_committed"]);
        }

        const probeLease = await store.acquireCompactionLease(`probe-${event}`);
        await probeLease.release();
      });
    },
  );

  it("runs prepare, intent, admission, provider, validation, shrink, and commit end to end", async () => {
    await withTransactionalStore("transaction-e2e", async (store) => {
      const source = appendSourceMessages(store, 8, 4_000);
      const provider = compactionProvider();
      const result = await runRealTransaction(store, source, provider);

      expect(provider.chat).toHaveBeenCalledOnce();
      expect(result.transaction).toBeDefined();
      const lifecycle = store.readAll().filter((item) =>
        isCompactionLifecycleItem(item),
      );
      expect(lifecycle.map((item) => item.type)).toEqual([
        "compaction_intent",
        "compaction_committed",
      ]);
      expect(store.readAll().some((item) => item.type === "compacted")).toBe(false);
      for (const item of lifecycle) {
        if (
          item.type === "compaction_intent" ||
          item.type === "compaction_committed"
        ) {
          expect(() =>
            readCompactionRolloutPayload(item.type, item.payload),
          ).not.toThrow();
        }
      }
      const reduced = reduceAll(store.readAll()).state.history;
      expect(reduced).toEqual(result.transaction?.committed.replacement_history);

      store.markProjectionComplete(result.transaction!.attempt_id);
      store.markCleanupComplete(result.transaction!.attempt_id);
      expect(() => store.assertCompactionProjectionReady()).not.toThrow();
    });
  });

  it("persists one provider_non_stop failure terminal and keeps source authoritative", async () => {
    await withTransactionalStore("transaction-non-stop", async (store) => {
      const source = appendSourceMessages(store, 8, 4_000);
      const provider = compactionProvider({ finishReason: "length" });
      await expect(runRealTransaction(store, source, provider)).rejects.toThrow(
        /finish reason was length/i,
      );
      const lifecycle = store.readAll().filter((item) =>
        isCompactionLifecycleItem(item),
      );
      expect(lifecycle.map((item) => item.type)).toEqual([
        "compaction_intent",
        "compaction_failed",
      ]);
      expect(lifecycle.at(-1)).toMatchObject({
        type: "compaction_failed",
        payload: { reason: "provider_non_stop" },
      });
      expect(reduceAll(store.readAll()).state.history.map((item) => item.content))
        .toEqual(source.map((message) => message.content));
    });
  });

  it("persists one no_shrink failure after a valid admitted provider result", async () => {
    await withTransactionalStore("transaction-no-shrink", async (store) => {
      const source = appendSourceMessages(store, 2, 32);
      const provider = compactionProvider();
      await expect(runRealTransaction(store, source, provider)).rejects.toThrow(
        /required 1024/i,
      );
      expect(provider.chat).toHaveBeenCalledOnce();
      expect(
        store.readAll().filter(isCompactionLifecycleItem),
      ).toMatchObject([
        { type: "compaction_intent" },
        { type: "compaction_failed", payload: { reason: "no_shrink" } },
      ]);
    });
  });

  it("fails closed when exact output accounting exceeds provider-reported usage", async () => {
    await withTransactionalStore("transaction-output-under-report", async (store) => {
      const source = appendSourceMessages(store, 8, 4_000);
      const provider = compactionProvider({
        usage: {
          promptTokens: 128,
          completionTokens: 1,
          totalTokens: 129,
          availability: "reported",
          provenance: "provider",
        },
      });
      await expect(runRealTransaction(store, source, provider)).rejects.toThrow(
        /under-reported output tokens/i,
      );
      expect(provider.chat).toHaveBeenCalledOnce();
      expect(store.readAll().filter(isCompactionLifecycleItem))
        .toMatchObject([
          { type: "compaction_intent" },
          { type: "compaction_failed", payload: { reason: "output_limit_exceeded" } },
        ]);
    });
  });

  it("records a commit failure terminal and leaves source history active", async () => {
    await withTransactionalStore("transaction-commit-failure", async (store) => {
      const source = appendSourceMessages(store, 8, 4_000);
      const provider = compactionProvider();
      const adapter = failingCommitAdapter(store);
      await expect(runRealTransaction(store, source, provider, {
        compactionTransaction: adapter,
      })).rejects.toThrow(/durable compaction commit failed/i);
      expect(store.readAll().filter(isCompactionLifecycleItem))
        .toMatchObject([
          { type: "compaction_intent" },
          { type: "compaction_failed", payload: { reason: "commit_failed" } },
        ]);
      expect(reduceAll(store.readAll()).state.history.map((item) => item.content))
        .toEqual(source.map((message) => message.content));
    });
  });

  it("holds the lease until an abort-ignoring provider physically settles", async () => {
    await withTransactionalStore("transaction-abort-quiescence", async (store) => {
      const source = appendSourceMessages(store, 8, 4_000);
      const baseProvider = compactionProvider();
      let enterProvider!: () => void;
      let releaseProvider!: () => void;
      const entered = new Promise<void>((resolve) => { enterProvider = resolve; });
      const gate = new Promise<void>((resolve) => { releaseProvider = resolve; });
      const chat = vi.fn(async (messages: LLMMessage[]) => {
        enterProvider();
        await gate;
        return await baseProvider.chat(messages);
      });
      const provider = { ...baseProvider, chat, chatStream: chat };
      const controller = new AbortController();
      const attempt = runRealTransaction(store, source, provider, {
        abortController: controller,
      });
      let settled = false;
      void attempt.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await entered;
      controller.abort(new DOMException("test abort", "AbortError"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(() => store.acquireCompactionLease("competing-attempt"))
        .toThrow(/already in progress/i);
      releaseProvider();
      await expect(attempt).rejects.toThrow(/test abort/i);
      expect(store.readAll().filter(isCompactionLifecycleItem))
        .toMatchObject([
          { type: "compaction_intent" },
          { type: "compaction_failed", payload: { reason: "aborted" } },
        ]);
      const nextLease = store.acquireCompactionLease("after-quiescence");
      await nextLease.release();
    });
  });

  it("rejects an oversized source-derived attachment before provider admission", async () => {
    await withTransactionalStore("transaction-attachment-limit", async (store) => {
      const source = appendSourceMessages(store, 2, 32);
      const provider = compactionProvider();
      const oversizedAttachmentBytes =
        MAX_COMPACTION_PAYLOAD_CANONICAL_UTF8_BYTES -
        MAX_COMPACTION_REPLACEMENT_SUMMARY_UTF8_BYTES -
        MAX_COMPACTION_REPLACEMENT_ENVELOPE_UTF8_BYTES +
        1_024;
      await expect(runRealTransaction(store, source, provider, {
        deps: {
          createAttachments: () => [{
            role: "user",
            content: "x".repeat(oversizedAttachmentBytes),
          }],
        },
      })).rejects.toThrow(/planned replacement history requires/i);
      expect(provider.chat).not.toHaveBeenCalled();
      expect(store.readAll().some((item) => item.type.startsWith("compaction_")))
        .toBe(false);
    });
  }, 30_000);

  it("redacts selected media from model input while preserving source provenance", async () => {
    await withTransactionalStore("transaction-media", async (store) => {
      const rawImageUrl = "https://private.example/secret-image.png";
      const rawDocument = "c2VjcmV0LWRvY3VtZW50LWJ5dGVz";
      const source: RuntimeMessage[] = [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: rawImageUrl } },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: rawDocument,
              },
              fallbackText: "bounded document description",
            },
            { type: "text", text: "Summarize the media context." },
          ],
        },
        ...Array.from({ length: 7 }, (_, index) => ({
          role: index % 2 === 0 ? "assistant" as const : "user" as const,
          content: `${index}:${"x".repeat(4_000)}`,
        })),
      ];
      for (const message of source) {
        store.appendRollout({
          type: "response_item",
          payload: {
            role: message.role ?? "user",
            content: message.content as string | ReadonlyArray<{
              readonly type: string;
              readonly text?: string;
              readonly [key: string]: unknown;
            }>,
          },
        }, { durable: true });
      }
      const before = store.prepareSource("media-provenance-probe", source);
      const provider = compactionProvider();
      const result = await runRealTransaction(store, source, provider);

      for (const [messages] of provider.chat.mock.calls) {
        const modelInput = JSON.stringify(messages);
        expect(modelInput).not.toContain(rawImageUrl);
        expect(modelInput).not.toContain(rawDocument);
        expect(modelInput).toContain("omitted from compaction model input");
      }
      expect(result.transaction?.committed.selected_history_indexes).toEqual(
        source.map((_, index) => index),
      );
      expect(result.transaction?.committed.source.history_digest)
        .toBe(before.source.history_digest);
      const physicalProvenance = (
        refs: typeof before.source.active_history_refs,
      ) => refs.map(({ ref_id: _attemptScopedRefId, ...ref }) => ref);
      expect(physicalProvenance(
        result.transaction!.committed.source.active_history_refs,
      )).toEqual(physicalProvenance(before.source.active_history_refs));
    });
  });
});

async function withTransactionalStore(
  sessionId: string,
  run: (store: RolloutStore) => Promise<void>,
): Promise<void> {
  const previousHome = process.env.AGENC_HOME;
  const home = mkdtempSync(join(tmpdir(), "agenc-c2-e2e-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-e2e-workspace-"));
  process.env.AGENC_HOME = home;
  const store = new RolloutStore({
    cwd,
    sessionId,
    agencVersion: "0.13.0",
    sessionTempRoot: tmpdir(),
    autoStartScheduler: false,
  });
  try {
    store.open({
      sessionId,
      timestamp: new Date().toISOString(),
      cwd,
      originator: "c2-production-e2e",
      agencVersion: "0.13.0",
      model: "test-model",
      modelProvider: "test-provider",
    });
    await run(store);
  } finally {
    store.close();
    if (previousHome === undefined) delete process.env.AGENC_HOME;
    else process.env.AGENC_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

function appendSourceMessages(
  store: RolloutStore,
  count: number,
  contentBytes: number,
): RuntimeMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const role = index % 2 === 0 ? "user" as const : "assistant" as const;
    const content = `${index}:${"x".repeat(contentBytes)}`;
    store.appendRollout(
      { type: "response_item", payload: { role, content } },
      { durable: true },
    );
    return { role, content, message: { role, content } };
  });
}

function compactionProvider(
  overrides: Partial<LLMResponse> = {},
  onChat?: () => void,
  factoryTools: readonly LLMTool[] = [],
  factoryConfig: Readonly<Record<string, unknown>> = {},
): LLMProvider & { readonly chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(async (messages: LLMMessage[]): Promise<LLMResponse> => {
    onChat?.();
    const payload = JSON.parse(String(messages[0]?.content)) as {
      readonly allowed_source_ref_ids: readonly string[];
    };
    return {
      content: JSON.stringify({
        narrative: "Bounded summary.",
        facts: [],
        open_actions: [],
        tool_pairs: [],
        allowed: payload.allowed_source_ref_ids.length > 0 ? undefined : true,
      }, (_key, value) => value === undefined ? undefined : value),
      toolCalls: [],
      usage: {
        promptTokens: 128,
        completionTokens: 128,
        totalTokens: 256,
        availability: "reported",
        provenance: "provider",
      },
      model: "grok-4.5",
      finishReason: "stop",
      ...overrides,
    };
  });
  const config = {
    ...factoryConfig,
    ...(factoryTools.length > 0 ? { tools: factoryTools } : {}),
  };
  return {
    name: "grok",
    ...(Object.keys(config).length > 0 ? { config } : {}),
    getExecutionProfile: async () => ({
      provider: "grok",
      model: "grok-4.5",
      contextWindowTokens: 64_000,
      usageReporting: "authoritative" as const,
      supportsMaxOutputTokens: true,
    }),
    chat,
    chatStream: chat,
    healthCheck: async () => true,
    tokenCountCapability: {
      capabilityVersion: "c2-contract-v1",
      adapterRevision: "c2-contract-adapter-v1",
      configurationRevision: "c2-contract-config-v1",
      countTokens: async (request: {
        readonly messages: readonly LLMMessage[];
        readonly options?: { readonly tools?: readonly unknown[] };
      }) => ({
        inputTokens: Math.max(
          1,
          Math.ceil(
            (Buffer.byteLength(JSON.stringify(request.messages), "utf8") +
              Buffer.byteLength(
                JSON.stringify(request.options?.tools ?? []),
                "utf8",
              )) / 4,
          ),
        ),
        complete: true as const,
        confidence: "exact" as const,
        countedComponents: ["messages" as const],
      }),
    },
  } as unknown as LLMProvider & { readonly chat: ReturnType<typeof vi.fn> };
}

async function runRealTransaction(
  store: RolloutStore,
  source: readonly RuntimeMessage[],
  provider: LLMProvider,
  overrides: TransactionRunOverrides = {},
) {
  const {
    automatic = false,
    customInstructions = "retain decisions",
    hooks = {
      executePreCompact: async () => ({}),
      executePostCompact: async () => ({}),
    },
    ...contextOverrides
  } = overrides;
  const admissionCwd = mkdtempSync(join(tmpdir(), "agenc-c2-admission-workspace-"));
  mkdirSync(join(admissionCwd, ".git"));
  const kernel = new ExecutionAdmissionKernel({
    agencHome: process.env.AGENC_HOME!,
    ownerId: `c2-transaction-${store.sessionId}`,
    ownerPid: process.pid,
  });
  const executionAdmission = kernel.bindClient({
    cwd: admissionCwd,
    scope: {
      runId: store.sessionId,
      sessionId: store.sessionId,
      autonomous: false,
    },
  });
  let eventSequence = 0;
  const permissionModeRegistry = {
    current: () => ({ mode: SESSION_PERMISSION_MODE }),
  };
  const admissionSession = {
    conversationId: store.sessionId,
    nextInternalSubId: () => "compaction-e2e-step",
    modelInfo: { slug: SESSION_MODEL, contextWindow: 64_000 },
    sessionConfiguration: {
      cwd: SESSION_CWD,
      collaborationMode: { model: SESSION_MODEL },
      permissionContext: { mode: SESSION_PERMISSION_MODE },
    },
    permissionModeRegistry,
    rolloutStore: store,
    emit: (event: Omit<Event, "seq">, options?: { readonly durable?: boolean }) => {
      const canonical = { ...event, seq: ++eventSequence } as Event;
      store.append(canonical, options);
      return canonical;
    },
    services: {
      provider,
      executionAdmission,
      admissionRequired: true,
      hooks,
      permissionModeRegistry,
    },
  } as unknown as Session;
  const unbind = bindExecutionAdmissionJournal(admissionSession, executionAdmission);
  try {
    return await compactConversationTransactionally(
      {
        provider,
        admissionSession,
        compactionTransaction: store,
        ...contextOverrides,
        options: {
          mainLoopModel: "grok-4.5",
          contextWindowTokens: 64_000,
          maxOutputTokens: 512,
        },
      },
      {
        customInstructions,
        automatic,
        messagesToKeep: [],
        completeSourceMessages: source,
        messagesToSummarize: source,
        summaryPlacement: "before_keep",
        createBoundaryMarker: () => ({
          role: "user",
          originalRole: "developer",
          content: "authenticated compaction boundary",
        }),
        createSummaryMessage: (content) => ({ role: "user", content }),
      },
    );
  } finally {
    unbind();
    kernel.close();
    rmSync(admissionCwd, { recursive: true, force: true });
  }
}

function providerCoveragePriority(
  provider: LLMProvider & { readonly chat: ReturnType<typeof vi.fn> },
): string {
  const messages = provider.chat.mock.calls[0]?.[0] as
    | readonly LLMMessage[]
    | undefined;
  const payload = JSON.parse(String(messages?.[0]?.content)) as {
    readonly coverage_priority?: unknown;
  };
  return typeof payload.coverage_priority === "string"
    ? payload.coverage_priority
    : "";
}

function observingTransactionAdapter(
  store: RolloutStore,
  timeline: string[],
): CompactionTransactionAdapter {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === "pinAndRecordIntent") {
        return (...args: unknown[]) => {
          const result = Reflect.apply(target.pinAndRecordIntent, target, args);
          timeline.push("intent");
          return result;
        };
      }
      if (property === "commit") {
        return (...args: unknown[]) => {
          const result = Reflect.apply(target.commit, target, args);
          timeline.push("commit");
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function failingCommitAdapter(
  store: RolloutStore,
): CompactionTransactionAdapter {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === "commit") {
        return () => {
          throw new Error("injected commit failure");
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function isCompactionLifecycleItem(item: RolloutItem): boolean {
  return item.type.startsWith("compaction_") &&
    item.type !== "compaction_payload_chunk";
}
