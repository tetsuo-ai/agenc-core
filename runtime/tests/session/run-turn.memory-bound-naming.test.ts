/**
 * Regression: memory-bound-naming (GAP #1 + #5) — in-memory bound.
 *
 * The OOM in-memory retention bound (`boundInMemoryToolResultContent` in
 * `src/session/run-turn.ts`) keyed compactability on the upstream tool names
 * "Read"/"Bash". The LIVE tool registry registers the whole-file reader as
 * "FileRead" (`FILE_READ_TOOL_NAME`) and the shell tool as "exec_command", so
 * the two LARGEST tool outputs — whole-file reads and shell/build/test logs —
 * were NEVER bounded in memory (the OOM fix missed its biggest targets) and
 * path-aware retention never fired for FileRead.
 *
 * The original OOM regression test used "Bash" (a name already in the set), so
 * the FileRead/exec_command miss regressed undetected. These tests drive REAL
 * `runTurn` with the LIVE "FileRead" tool name and prove:
 *  (a) FileRead tool-result bytes stay BOUNDED across many large-output turns
 *      (with the naming bug they would grow ~linearly), and
 *  (b) the most-recent FileRead for the ACTIVE path is retained full while
 *      older reads of the same path are cleared.
 *
 * Both FAIL when "FileRead"/path-bearing FileRead are removed from the bound.
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

import { AsyncQueue } from "../../src/utils/async-queue.js";
import { FILE_READ_TOOL_NAME } from "../../src/tools/system/file-read.js";
import {
  Session,
  type Event,
  type SessionOpts,
  type SessionServices,
} from "../../src/session/session.js";
import { TurnTimingState } from "../../src/session/turn-context.js";
import type {
  Config,
  ManagedFeatures,
  ModelInfo,
  SessionConfiguration,
  TurnContext,
} from "../../src/session/turn-context.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "../../src/llm/types.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import type { Tool } from "../../src/tools/types.js";

const LARGE_TOOL_OUTPUT_BYTES = 80_000; // > clear threshold (6_000).
const KEEP_RECENT = 5; // mirrors the in-memory keep-recent window.
const CLEARED_MARKER = "[Old tool result content cleared]";
const UNTRUSTED_TOOL_RESULT_BOUNDARY =
  "===== AGENC UNTRUSTED TOOL RESULT DATA =====";
// The shell tool registers as "exec_command" in the live registry. Mirrored
// here (no exported source constant) so the test keys on the LIVE name.
const EXEC_COMMAND_TOOL_NAME = "exec_command";

let restoreEnv: (() => void) | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv?.();
  restoreEnv = undefined;
});

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
 * Provider that issues exactly one tool call per turn (first stream), then
 * stops with final text (second stream). `callForTurn` picks the tool name and
 * arguments per turn so a test can drive FileRead (with `file_path`) and/or the
 * non-path-bearing exec_command.
 */
function mkPerTurnToolProvider(
  callForTurn: (turn: number) => {
    readonly name: string;
    readonly arguments: string;
  },
): LLMProvider {
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
        const { name, arguments: args } = callForTurn(turnIndex);
        return {
          ...base,
          toolCalls: [
            { id: `tool_call_turn_${turnIndex}`, name, arguments: args },
          ],
          finishReason: "tool_calls",
        };
      }
      streamInTurn = 0;
      return { ...base, content: `done ${turnIndex}` };
    },
    healthCheck: async () => true,
  };
}

/**
 * Registry whose tools (FileRead + exec_command) return a large, turn-tagged
 * output well over the clear threshold so each turn's result is distinguishable.
 */
function mkLargeToolRegistry(): ToolRegistry {
  let dispatchCount = 0;
  const out = (): { content: string; isError: boolean } => {
    dispatchCount += 1;
    const tag = `TOOLOUT_${dispatchCount}_`;
    return { content: `${tag}${"x".repeat(LARGE_TOOL_OUTPUT_BYTES)}`, isError: false };
  };
  const mkTool = (name: string): Tool => ({
    name,
    description: `large output ${name}`,
    inputSchema: { type: "object", additionalProperties: true },
    requiresApproval: false,
    execute: async () => out(),
  });
  return {
    tools: [mkTool(FILE_READ_TOOL_NAME), mkTool(EXEC_COMMAND_TOOL_NAME)],
    toLLMTools: () => [],
    dispatch: async () => out(),
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
} {
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
    conversationId: "conv-mem-fr",
    services,
    initialState: state as unknown as SessionOpts["initialState"],
    features: mkFeatures(),
    jsRepl: { id: "repl-mem-fr" },
    config: mkConfig(),
    modelInfo: mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
  });
  (session as unknown as { rolloutStore: unknown }).rolloutStore = {
    append: vi.fn(),
    appendRollout: vi.fn(),
    store: { reAppendSessionMetadata: vi.fn() },
  };
  return { session, getHistory: () => state.history };
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
    total += Buffer.byteLength(messageText(message), "utf8");
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

describe("runTurn — memory-bound-naming in-memory bound (FileRead)", () => {
  test(
    "(a) FileRead tool-result bytes stay bounded across many large-output " +
      "turns (regresses when 'FileRead' is absent from the in-memory bound)",
    async () => {
      disableAutoCompact();
      // Every turn re-reads the SAME file (the realistic working-file loop:
      // edit → re-read). Path-aware retention keeps only its latest result, so
      // growth is bounded by the recent-N window. With the naming bug FileRead
      // is not compactable, so NOTHING is bounded and bytes grow ~linearly.
      const provider = mkPerTurnToolProvider(() => ({
        name: FILE_READ_TOOL_NAME,
        arguments: JSON.stringify({ file_path: "/src/working.ts" }),
      }));
      const registry = mkLargeToolRegistry();
      const { session, getHistory } = mkSession({ provider, registry });

      const FEW_TURNS = 3;
      const MANY_TURNS = 30;

      for (let i = 0; i < FEW_TURNS; i += 1) {
        await drain(session.runTurn(`turn ${i}`, { ctx: mkCtx() }));
      }
      const bytesAfterFew = toolResultBytes(getHistory());

      for (let i = FEW_TURNS; i < MANY_TURNS; i += 1) {
        await drain(session.runTurn(`turn ${i}`, { ctx: mkCtx() }));
      }
      const bytesAfterMany = toolResultBytes(getHistory());

      const perResultCeil = LARGE_TOOL_OUTPUT_BYTES + 4_096;
      const boundedCeiling = (KEEP_RECENT + 1) * perResultCeil;
      // Bounded: capped at ~KEEP_RECENT full results regardless of turn count.
      expect(bytesAfterMany).toBeLessThan(boundedCeiling);

      // Anti-linear-growth: with the naming bug nothing is bounded and this
      // would be ~MANY_TURNS * 80KB (~2.4MB).
      const linearBytes = MANY_TURNS * LARGE_TOOL_OUTPUT_BYTES;
      expect(bytesAfterMany).toBeLessThan(linearBytes * 0.5);

      // 10x more turns must NOT scale retained bytes.
      expect(bytesAfterMany).toBeLessThan(
        bytesAfterFew + (KEEP_RECENT + 1) * perResultCeil,
      );

      // Recent exec_command results stay full; the latest turn's output present.
      const history = getHistory();
      const fullResults = history.filter(
        (m) =>
          (m.role === "tool" || m.toolCallId !== undefined) &&
          messageText(m).length >= LARGE_TOOL_OUTPUT_BYTES,
      );
      expect(fullResults.length).toBeGreaterThan(0);
      expect(fullResults.length).toBeLessThanOrEqual(KEEP_RECENT + 1);
      const latestResult = fullResults.find(
        (message) => message.toolCallId === `tool_call_turn_${MANY_TURNS}`,
      );
      expect(latestResult).toBeDefined();
      const latestResultText = messageText(latestResult!);
      expect(latestResultText).toContain(
        "untrusted workspace data from FileRead",
      );
      expect(latestResultText).toContain(`TOOLOUT_${MANY_TURNS}_`);
      expect(
        latestResultText.split(UNTRUSTED_TOOL_RESULT_BOUNDARY),
      ).toHaveLength(3);

      // Older large results were cleared to the marker.
      const clearedMarkers = history.filter(
        (m) =>
          (m.role === "tool" || m.toolCallId !== undefined) &&
          messageText(m) === CLEARED_MARKER,
      );
      expect(clearedMarkers.length).toBeGreaterThan(0);
    },
    30_000,
  );

  test(
    "(b) the latest FileRead of the ACTIVE path is retained full even OUTSIDE " +
      "the recent-N window (path-aware retention; regresses when FileRead is " +
      "not path-bearing in the in-memory bound — then it is evicted)",
    async () => {
      disableAutoCompact();
      const ACTIVE_PATH = "/src/active.ts";
      const OTHER_PATH = "/src/other.ts";
      // Turn 1 reads the ACTIVE path ONCE. Turns 2..TOTAL repeatedly read the
      // SAME OTHER path. With TOTAL well past the recent-N window, the turn-1
      // ACTIVE read sits OUTSIDE recent-N, so ONLY path-aware retention (which
      // requires FileRead in IN_MEMORY_PATH_BEARING_READ_TOOLS) keeps it full.
      // Without that, the active read is evicted and the agent re-reads it.
      const TOTAL_TURNS = 12;
      const provider = mkPerTurnToolProvider((turn) => ({
        name: FILE_READ_TOOL_NAME,
        arguments: JSON.stringify({
          file_path: turn === 1 ? ACTIVE_PATH : OTHER_PATH,
        }),
      }));
      const registry = mkLargeToolRegistry();
      const { session, getHistory } = mkSession({ provider, registry });

      for (let i = 0; i < TOTAL_TURNS; i += 1) {
        await drain(session.runTurn(`turn ${i}`, { ctx: mkCtx() }));
      }

      const history = getHistory();
      const byCallId = new Map<string, string>();
      for (const m of history) {
        if (m.role !== "tool" && m.toolCallId === undefined) continue;
        if (typeof m.toolCallId === "string") {
          byCallId.set(m.toolCallId, messageText(m));
        }
      }

      // The turn-1 ACTIVE read — the latest (only) read of the active path —
      // is retained FULL despite being far outside the recent-N window.
      const activeRead = byCallId.get("tool_call_turn_1");
      expect(activeRead).toBeDefined();
      expect((activeRead ?? "").length).toBeGreaterThanOrEqual(
        LARGE_TOOL_OUTPUT_BYTES,
      );

      // An OLD read of the OTHER path (turn 2), outside recent-N and superseded
      // by later OTHER-path reads, IS cleared — proving clearing actually fired
      // and the active-path retention is path-aware, not just the window.
      const oldOther = byCallId.get("tool_call_turn_2");
      expect(oldOther).toBe(CLEARED_MARKER);

      // The most-recent OTHER read (turn TOTAL, within recent-N) stays full.
      const latestOther = byCallId.get(`tool_call_turn_${TOTAL_TURNS}`);
      expect((latestOther ?? "").length).toBeGreaterThanOrEqual(
        LARGE_TOOL_OUTPUT_BYTES,
      );
    },
    30_000,
  );
});
