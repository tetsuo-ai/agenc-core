/**
 * Regression: session-history-memory (GB-scale heap leak).
 *
 * Full tool-output content (build logs, large file reads, ctest output)
 * otherwise accumulated UNBOUNDED in the live in-memory session for the whole
 * session — in BOTH `state.messages` and the deep-cloned `sessionState.history`
 * synced every turn — causing OOM. The intended microcompaction only shrank the
 * OUTBOUND request (`messagesForQuery`); the durable in-memory copy kept the
 * full content forever.
 *
 * The fix bounds the IN-MEMORY tool-result retention the same way microcompact
 * decides: the most-recent-N compactable tool results stay full, OLDER large
 * compactable tool-result content is replaced with a compact marker. The disk
 * rollout MUST still receive the full content (for resume), and the bound is
 * only ever applied AFTER the full content has been persisted.
 *
 * These tests prove:
 *  - after many turns each with a large (>64KB) tool result, the total bytes of
 *    tool-result content retained in the in-memory session
 *    (`sessionState.history`) stays BOUNDED (does not grow ~linearly with turn
 *    count),
 *  - the most-recent few tool results keep their full content,
 *  - the rollout persisted to disk still carries the full content for resume.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("axios", () => {
  const axiosLike = {
    create: vi.fn(() => axiosLike),
    get: vi.fn(),
    post: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  return {
    default: axiosLike,
    create: axiosLike.create,
    isAxiosError: () => false,
  };
});

import { AsyncQueue } from "../utils/async-queue.js";
import {
  Session,
  type Event,
  type SessionOpts,
  type SessionServices,
} from "./session.js";
import { TurnTimingState } from "./turn-context.js";
import type {
  Config,
  ManagedFeatures,
  ModelInfo,
  SessionConfiguration,
  TurnContext,
} from "./turn-context.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "../llm/types.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { Tool } from "../tools/types.js";

const LARGE_TOOL_OUTPUT_BYTES = 80_000; // > 64KB, well over the clear threshold.
const KEEP_RECENT = 5; // mirrors microcompact's keep-recent window.
const CLEARED_MARKER = "[Old tool result content cleared]";
const UNTRUSTED_TOOL_RESULT_BOUNDARY =
  "===== AGENC UNTRUSTED TOOL RESULT DATA =====";

let restoreEnv: (() => void) | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv?.();
  restoreEnv = undefined;
});

// Isolate the IN-MEMORY retention bound under test from auto-compaction:
// auto-compact would otherwise replace history wholesale (a separate path),
// hiding the linear-growth-vs-bounded distinction this test asserts. With a
// large context window and auto-compact disabled, history accumulates across
// turns exactly as it does in the real leak, and only the new in-memory
// retention bound keeps it from growing ~linearly.
function disableAutoCompact(): void {
  const prev = process.env.DISABLE_AUTO_COMPACT;
  process.env.DISABLE_AUTO_COMPACT = "1";
  restoreEnv = () => {
    if (prev === undefined) delete process.env.DISABLE_AUTO_COMPACT;
    else process.env.DISABLE_AUTO_COMPACT = prev;
  };
}

function mkCtx(): TurnContext {
  return {
    subId: "turn-mem",
    cwd: "/tmp",
    config: { maxTurns: 100 } as unknown,
    configSnapshot: {} as unknown,
    modelInfo: {
      slug: "test-model",
      effectiveContextWindowPercent: 100,
      // Large window so auto-compact never fires; the in-memory retention
      // bound is what must keep history from growing linearly.
      contextWindow: 100_000_000,
      supportedReasoningLevels: [],
      defaultReasoningSummary: "auto",
      truncationPolicy: "off",
      usedFallbackModelMetadata: false,
    },
    collaborationMode: { model: "test-model" },
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "read_only" },
    fileSystemSandboxPolicy: {
      allowWrite: [],
      denyWrite: [],
      allowRead: [],
      denyRead: [],
    },
    networkSandboxPolicy: {
      allowlist: [],
      denylist: [],
      allowManagedDomainsOnly: false,
    },
    reasoningSummary: "auto",
    sessionSource: "cli_main",
    currentDate: "2026-05-30",
    timezone: "Etc/UTC",
    dynamicTools: [],
    depth: 0,
    toolCallGate: {
      isReady: () => true,
      signal: () => {},
      wait: async () => {},
    },
    turnTimingState: new TurnTimingState(),
  } as unknown as TurnContext;
}

/**
 * Provider that, per `runTurn` invocation, issues exactly one compactable
 * (Bash) tool call on its first stream, then stops with final text on the
 * second stream. The tool-call id encodes the turn number so each turn adds a
 * distinct large tool result to history.
 */
function mkPerTurnToolProvider(): LLMProvider {
  let turnIndex = 0;
  let streamInTurn = 0;
  const base: LLMResponse = {
    content: "",
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: "test-model",
    finishReason: "stop",
  };
  return {
    name: "per-turn-tool-provider",
    chat: async () => ({ ...base }),
    chatStream: async (
      _messages: LLMMessage[],
      _onChunk: StreamProgressCallback,
    ): Promise<LLMResponse> => {
      streamInTurn += 1;
      if (streamInTurn === 1) {
        turnIndex += 1;
        return {
          ...base,
          toolCalls: [
            {
              id: `bash_call_turn_${turnIndex}`,
              name: "Bash",
              arguments: "{}",
            },
          ],
          finishReason: "tool_calls",
        };
      }
      streamInTurn = 0; // reset for the next runTurn.
      return { ...base, content: `done ${turnIndex}` };
    },
    healthCheck: async () => true,
  };
}

/**
 * Bash tool registry returning a large, turn-tagged output so each turn's
 * result is distinguishable and well over the clear threshold.
 */
function mkLargeBashRegistry(): ToolRegistry {
  let dispatchCount = 0;
  const tool: Tool = {
    name: "Bash",
    description: "large output bash",
    inputSchema: { type: "object", additionalProperties: false },
    requiresApproval: false,
    execute: async () => {
      dispatchCount += 1;
      const tag = `BASHOUT_${dispatchCount}_`;
      const body = "x".repeat(LARGE_TOOL_OUTPUT_BYTES);
      return { content: `${tag}${body}`, isError: false };
    },
  };
  return {
    tools: [tool],
    toLLMTools: () => [],
    dispatch: async () => {
      dispatchCount += 1;
      const tag = `BASHOUT_${dispatchCount}_`;
      const body = "x".repeat(LARGE_TOOL_OUTPUT_BYTES);
      return { content: `${tag}${body}`, isError: false };
    },
  } as unknown as ToolRegistry;
}

function mkFeatures(): ManagedFeatures {
  return {
    appsEnabledForAuth: () => false,
    useLegacyLandlock: () => false,
  } as unknown as ManagedFeatures;
}

function mkConfig(): Config {
  return {
    model: "test-model",
    cwd: "/tmp",
    features: mkFeatures(),
    multiAgentV2: {
      usageHintEnabled: false,
      usageHintText: "",
      hideSpawnAgentMetadata: false,
    },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: { allowedEnvVars: [], blockedEnvVars: [] },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  } as unknown as Config;
}

function mkModelInfo(): ModelInfo {
  return {
    slug: "test-model",
    effectiveContextWindowPercent: 100,
    contextWindow: 1024,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  } as unknown as ModelInfo;
}

function mkSessionConfiguration(): SessionConfiguration {
  return {
    cwd: "/tmp",
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "read_only" },
    fileSystemSandboxPolicy: {
      allowWrite: [],
      denyWrite: [],
      allowRead: [],
      denyRead: [],
    },
    networkSandboxPolicy: {
      allowlist: [],
      denylist: [],
      allowManagedDomainsOnly: false,
    },
    windowsSandboxLevel: "none",
    collaborationMode: { model: "test-model" },
    dynamicTools: [],
    sessionSource: "cli_main",
    provider: { slug: "stub-provider" },
  } as unknown as SessionConfiguration;
}

function mkSession(opts: {
  readonly provider: LLMProvider;
  readonly registry: ToolRegistry;
}): {
  readonly session: Session;
  readonly getHistory: () => LLMMessage[];
  readonly appendRollout: ReturnType<typeof vi.fn>;
} {
  // `state` is the LIVE in-memory session-state object. `syncSessionState`
  // writes `state.history` in place, so reading it back after each turn
  // observes exactly the durable in-memory retention under test.
  const state: {
    sessionConfiguration: SessionConfiguration;
    history: LLMMessage[];
    totalTokenUsage: number;
  } = {
    sessionConfiguration: mkSessionConfiguration(),
    history: [],
    totalTokenUsage: 0,
  };
  const services: SessionServices = {
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
    provider: opts.provider,
    registry: opts.registry,
    querySource: "repl_main_thread",
    hooks: {
      executeStop: async () => ({}),
      postToolUseHooks: [],
    },
  } as unknown as SessionServices;
  const session = new Session({
    conversationId: "conv-mem",
    services,
    initialState: state as unknown as SessionOpts["initialState"],
    features: mkFeatures(),
    jsRepl: { id: "repl-mem" },
    config: mkConfig(),
    modelInfo: mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
  });
  const appendRollout = vi.fn();
  (session as unknown as { rolloutStore: unknown }).rolloutStore = {
    append: vi.fn(),
    appendRollout,
    store: {
      reAppendSessionMetadata: vi.fn(),
    },
  };
  const getHistory = (): LLMMessage[] => state.history;
  return { session, getHistory, appendRollout };
}

async function drain(gen: AsyncGenerator<unknown, unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of gen) {
    // drain
  }
}

function toolResultBytes(messages: readonly LLMMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role !== "tool" && message.toolCallId === undefined) continue;
    if (typeof message.content === "string") {
      total += Buffer.byteLength(message.content, "utf8");
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { readonly text?: unknown }).text;
          if (typeof text === "string") {
            total += Buffer.byteLength(text, "utf8");
          }
        }
      }
    }
  }
  return total;
}

function messageText(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { readonly text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

function rolloutText(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const payload = (item as { readonly payload?: { readonly content?: unknown } })
    .payload;
  const content = payload?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { readonly text?: unknown }).text ?? "")
        : "",
    )
    .join("\n");
}

describe("runTurn — session-history-memory in-memory retention bound", () => {
  test(
    "in-memory tool-result bytes stay bounded across many large-output turns " +
      "while recent results stay full and the rollout keeps full content",
    async () => {
      disableAutoCompact();
      const provider = mkPerTurnToolProvider();
      const registry = mkLargeBashRegistry();
      const { session, getHistory, appendRollout } = mkSession({
        provider,
        registry,
      });

      const FEW_TURNS = 3;
      const MANY_TURNS = 30;

      // Run a few turns and snapshot retained tool-result bytes.
      for (let i = 0; i < FEW_TURNS; i += 1) {
        await drain(session.runTurn(`turn ${i}`, { ctx: mkCtx() }));
      }
      const bytesAfterFew = toolResultBytes(getHistory());

      // Run many more turns.
      for (let i = FEW_TURNS; i < MANY_TURNS; i += 1) {
        await drain(session.runTurn(`turn ${i}`, { ctx: mkCtx() }));
      }
      const bytesAfterMany = toolResultBytes(getHistory());

      // Bound: only the most-recent-N tool results retain full content, so the
      // retained tool-result bytes are capped at ~KEEP_RECENT full results
      // regardless of turn count.
      const perResultCeil = LARGE_TOOL_OUTPUT_BYTES + 4_096;
      const boundedCeiling = (KEEP_RECENT + 1) * perResultCeil;
      expect(bytesAfterMany).toBeLessThan(boundedCeiling);

      // Anti-linear-growth: retained bytes must be a SMALL FRACTION of what
      // unbounded accumulation would hold (~MANY_TURNS * 80KB ≈ 2.4MB). With
      // KEEP_RECENT=5 full results, retention is ~5/30 ≈ 17% of linear; assert
      // a comfortable < 50% to stay robust.
      const linearBytes = MANY_TURNS * LARGE_TOOL_OUTPUT_BYTES;
      expect(bytesAfterMany).toBeLessThan(linearBytes * 0.5);

      // Going from FEW turns to MANY turns (10x) must NOT scale retained bytes:
      // once past the keep-recent window, adding turns adds only markers.
      expect(bytesAfterMany).toBeLessThan(
        bytesAfterFew + (KEEP_RECENT + 1) * perResultCeil,
      );

      // The most-recent few tool results keep their FULL content.
      const history = getHistory();
      const fullToolResults = history.filter(
        (m) =>
          (m.role === "tool" || m.toolCallId !== undefined) &&
          messageText(m).length >= LARGE_TOOL_OUTPUT_BYTES,
      );
      expect(fullToolResults.length).toBeGreaterThan(0);
      expect(fullToolResults.length).toBeLessThanOrEqual(KEEP_RECENT);
      // The latest turn's output must be present full.
      const latestTag = `BASHOUT_${MANY_TURNS}_`;
      const latestResult = fullToolResults.find(
        (message) => message.toolCallId === `bash_call_turn_${MANY_TURNS}`,
      );
      expect(latestResult).toBeDefined();
      const latestResultText = messageText(latestResult!);
      expect(latestResultText).toContain("untrusted workspace data from Bash");
      expect(latestResultText).toContain(latestTag);
      expect(
        latestResultText.split(UNTRUSTED_TOOL_RESULT_BOUNDARY),
      ).toHaveLength(3);

      // Older large results were replaced with the compact marker in memory.
      const clearedMarkers = history.filter(
        (m) =>
          (m.role === "tool" || m.toolCallId !== undefined) &&
          messageText(m) === CLEARED_MARKER,
      );
      expect(clearedMarkers.length).toBeGreaterThan(0);

      // The DISK ROLLOUT retains FULL content for EVERY turn (resume safety):
      // the first turn's large output must still be present in full on disk
      // even though it was cleared from the in-memory history.
      const rolloutBlob = appendRollout.mock.calls
        .map(([item]) => rolloutText(item))
        .join("\n");
      expect(rolloutBlob).toContain("BASHOUT_1_");
      // ...and the full body (not a marker) — verify a long run of the body.
      expect(rolloutBlob).toContain("x".repeat(LARGE_TOOL_OUTPUT_BYTES));
      // The marker must NEVER leak into the durable rollout.
      expect(rolloutBlob).not.toContain(CLEARED_MARKER);
    },
    30_000,
  );
});
