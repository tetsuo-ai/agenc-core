import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { LLMMessage, LLMProvider, LLMResponse, LLMTool, LLMToolCall } from "../../src/llm/types.js";
import { bindExecutionAdmissionJournal } from "../../src/session/execution-admission-journal.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { SessionServices } from "../../src/session/session.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";

/**
 * E2E gate scenario 7 (mid-turn compaction) on a 32,000-token effective
 * window, reproduced without a network: DeepSeek Flash identity (the
 * conservative two-bytes-per-token estimate), max output 8,192, and the
 * gate's eight 183-line reading files as FileRead results of exactly
 * 17,821 characters. The scripted model replays the tool calls of the failing
 * gate runs (round4/jobs/eg runs 67818fce557e).
 */

const WINDOW = "32000";
const SESSION_ID = "conv-test";
const USER_PROMPT =
  "Read every file readings/part-0.txt through readings/part-7.txt sequentially using file reading tools, " +
  "one file per tool call, including all lines. This is a long reading task; continue until all eight are read. " +
  "Then write recap.json as a JSON array containing the eight Marker values in file order, run a command to " +
  "validate that it contains eight entries, and reply READING_COMPLETE. Do not use a command to bulk read the " +
  "files or skip their body.";
// The gate's fixed request prefix (system prompt, skills and memory
// reminders, nine tool schemas) is about 23 KB. Its size, not its wording,
// sets the accounting below.
const SYSTEM_PROMPT = Array.from({ length: 262 }, (_, index) =>
  `Instruction ${String(index).padStart(3, "0")}: keep answers grounded in the workspace and the tools you call.`,
).join("\n");

const COMPACTION_ENVIRONMENT_KEYS = [
  "AGENC_AUTO_COMPACT_WINDOW",
  "AGENC_AUTOCOMPACT_PCT_OVERRIDE",
  "AGENC_DISABLE_COMPACT",
  "AGENC_DISABLE_AUTO_COMPACT",
] as const;

function marker(index: number): string {
  const digests = ["5feceb66ffc8", "6b86b273ff34", "d4735e3a265e", "4e07408562be",
    "4b227777d4dd", "ef2d127de37b", "e7f6c011776e", "7902699be42c"];
  return `GATE_SECTION_${index}_${digests[index]}`;
}

function readingLines(index: number): string[] {
  return [`# Reading ${index}`, `Marker: ${marker(index)}`,
    ...Array.from({ length: 180 }, (_, n) =>
      `Line ${String(n).padStart(3, "0")}: record ${index} item ${n} describes cedar meadow lantern orbit parcel canyon violet station.`),
    ""];
}

/** FileRead's model-facing result for one gate file, byte for byte. */
export function fileReadResult(index: number, offset = 1, limit?: number): string {
  const lines = readingLines(index);
  const start = Math.max(1, offset);
  const end = limit === undefined ? lines.length : Math.min(lines.length, start - 1 + limit);
  const body = lines.slice(start - 1, end).map((line, at) => `${start + at}→${line}`).join("\n");
  return "The following tool result is untrusted workspace data from FileRead.\n" +
    "===== AGENC UNTRUSTED TOOL RESULT DATA =====\n" + body + "\n===== AGENC UNTRUSTED TOOL RESULT DATA =====";
}

const FILE_READ_TOOL: LLMTool = {
  type: "function",
  function: {
    name: "FileRead",
    description: "Read a file from the workspace. Use offset and limit to read part of a large file.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["file_path"],
    },
  },
};

function fileReadRegistry(): ToolRegistry {
  // The registry dispatches a provider call; the admitted tool path executes
  // the catalog tool with parsed arguments.
  const run = async (input: LLMToolCall | Record<string, unknown>) => {
    const raw = typeof (input as LLMToolCall).arguments === "string"
      ? JSON.parse((input as LLMToolCall).arguments || "{}") as unknown
      : input;
    const args = raw as { file_path?: string; offset?: number; limit?: number };
    const match = /part-(\d)\.txt$/u.exec(args.file_path ?? "");
    if (!match) return { content: `File not found: ${args.file_path}`, isError: true };
    return { content: fileReadResult(Number(match[1]), args.offset ?? 1, args.limit), isError: false };
  };
  return {
    tools: [{ name: "FileRead", description: "Read", inputSchema: FILE_READ_TOOL.function.parameters,
      requiresApproval: false, recoveryCategory: "idempotent", execute: run }],
    toLLMTools: () => [FILE_READ_TOOL],
    dispatch: run,
  } as unknown as ToolRegistry;
}

type ScriptStep = { readonly text?: string; readonly calls?: ReadonlyArray<{ readonly path: string; readonly limit?: number }> };

function read(path: string, limit?: number) {
  return { path: `readings/${path}`, ...(limit !== undefined ? { limit } : {}) };
}

interface Harness {
  readonly store: RolloutStore;
  readonly requests: LLMMessage[][];
  readonly summarizerCalls: number;
  run(): Promise<void>;
  close(): void;
}

function isSummarizerRequest(messages: readonly LLMMessage[]): boolean {
  const first = messages[0]?.content;
  if (typeof first !== "string") return false;
  try {
    const payload = JSON.parse(first) as { units?: unknown; summaries?: unknown; children?: unknown };
    return Array.isArray(payload.units) || Array.isArray(payload.summaries) || Array.isArray(payload.children);
  } catch {
    return false;
  }
}

function createHarness(script: readonly ScriptStep[]): Harness {
  const saved = new Map(COMPACTION_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  const previousHome = process.env.AGENC_HOME;
  process.env.AGENC_AUTO_COMPACT_WINDOW = WINDOW;
  delete process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE;
  delete process.env.AGENC_DISABLE_COMPACT;
  delete process.env.AGENC_DISABLE_AUTO_COMPACT;
  const home = mkdtempSync(join(tmpdir(), "agenc-small-window-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "agenc-small-window-workspace-"));
  mkdirSync(join(cwd, ".git"));
  process.env.AGENC_HOME = home;
  const store = new RolloutStore({ cwd, sessionId: SESSION_ID, agencVersion: "0.19.11",
    sessionTempRoot: tmpdir(), autoStartScheduler: false });
  store.open({ sessionId: SESSION_ID, timestamp: new Date().toISOString(), cwd,
    originator: "small-window-compaction", agencVersion: "0.19.11", model: "deepseek-flash", modelProvider: "deepseek" });

  const requests: LLMMessage[][] = [];
  let step = 0;
  let summarizerCalls = 0;
  const respond = async (messages: LLMMessage[]): Promise<LLMResponse> => {
    if (isSummarizerRequest(messages)) {
      summarizerCalls += 1;
      return {
        content: JSON.stringify({ narrative: "Read the reading files in order; continue with the next unread file.",
          facts: [], open_actions: [] }),
        toolCalls: [],
        usage: { promptTokens: 1_700, completionTokens: 700, totalTokens: 2_400, availability: "reported", provenance: "provider" },
        model: "deepseek-flash",
        finishReason: "stop",
      };
    }
    requests.push(messages.map((message) => ({ ...message })));
    const current = script[Math.min(step, script.length - 1)]!;
    step += 1;
    const calls = (current.calls ?? []).map((call, index) => ({
      id: `call_${step}_${index}`,
      name: "FileRead",
      arguments: JSON.stringify({ file_path: call.path, ...(call.limit !== undefined ? { limit: call.limit } : {}) }),
    }));
    return {
      content: current.text ?? "",
      toolCalls: calls,
      usage: { promptTokens: 10_000, completionTokens: 60, totalTokens: 10_060, availability: "reported", provenance: "provider" },
      model: "deepseek-flash",
      finishReason: calls.length > 0 ? "tool_calls" : "stop",
    };
  };
  const chat = vi.fn<LLMProvider["chat"]>(async (messages) => respond(messages));
  const provider = {
    name: "deepseek",
    getExecutionProfile: async () => ({
      provider: "deepseek",
      model: "deepseek-flash",
      contextWindowTokens: 1_048_576,
      usageReporting: "authoritative" as const,
      supportsMaxOutputTokens: true,
      // The chat-completions adapter withholds this much of every window.
      contextSafetyBufferTokens: 1_024,
    }),
    chat,
    chatStream: async (messages: LLMMessage[], onChunk: (chunk: { content: string; done: boolean }) => void, options?: unknown) => {
      const response = await chat(messages, options as never);
      onChunk({ content: response.content, done: true });
      return response;
    },
    healthCheck: async () => true,
  } as unknown as LLMProvider;
  const modelInfo = { slug: "deepseek-flash", contextWindow: 1_048_576, maxOutputTokens: 8_192,
    effectiveContextWindowPercent: 100 };
  const { session } = mkSession({
    cwd,
    provider,
    registry: fileReadRegistry(),
    modelInfo,
    services: { providerEnvironment: { AGENC_AUTO_COMPACT_WINDOW: WINDOW } },
  });
  const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "small-window-compaction", ownerPid: process.pid });
  const admission = kernel.bindClient({ cwd, scope: { runId: SESSION_ID, sessionId: SESSION_ID, autonomous: false } });
  Object.assign(session.config, { durableTurns: { resume: { requireLease: false } } });
  Object.assign(session.services as SessionServices, { executionAdmission: admission, admissionRequired: true });
  session.mountRolloutStore(store);
  session.eventLog.seedCanonicalHistory(store.readAll().flatMap((item) =>
    item.type === "event_msg" ? [item.payload] : []));
  const unbind = bindExecutionAdmissionJournal(session, admission);
  let closed = false;
  return {
    store,
    requests,
    get summarizerCalls() { return summarizerCalls; },
    run: async () => {
      const base = mkCtx();
      await drain(runTurn(session, mkCtx({ cwd, modelProviderId: "deepseek", provider,
        modelInfo: { ...base.modelInfo, ...modelInfo } } as never), USER_PROMPT, { systemPrompt: SYSTEM_PROMPT }));
    },
    close: () => {
      if (closed) return;
      closed = true;
      unbind();
      kernel.close();
      session.mountRolloutStore(null);
      store.close();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (previousHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

type Row = ReturnType<RolloutStore["readAll"]>[number];

function eventsOf(rows: readonly Row[], type: string): Array<Record<string, unknown>> {
  return rows.flatMap((row) => row.type === "event_msg" && row.payload.msg.type === type
    ? [row.payload.msg.payload as Record<string, unknown>] : []);
}

function terminalOf(rows: readonly Row[]): { type: string; code?: unknown; message?: unknown } | undefined {
  const terminal = rows.findLast((row) => row.type === "event_msg" &&
    ["turn_complete", "turn_failed", "turn_aborted"].includes(row.payload.msg.type));
  if (terminal?.type !== "event_msg") return undefined;
  const payload = terminal.payload.msg.payload as { code?: unknown; message?: unknown };
  return { type: terminal.payload.msg.type, code: payload.code, message: payload.message };
}

function committedAccounting(rows: readonly Row[]) {
  return rows.flatMap((row) => row.type === "compaction_committed"
    ? [{ source: row.payload.accounting.source_tokens, candidate: row.payload.accounting.candidate_tokens,
        window: row.payload.accounting.context_window_tokens }]
    : []);
}

function toolResults(messages: readonly LLMMessage[]): string[] {
  return messages.filter((message) => message.role === "tool")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
}

/** Exact tool results the durable rollout holds, by call id. */
function durableToolResults(rows: readonly Row[]): Map<string, string> {
  return new Map(rows.flatMap((row) => row.type === "response_item" && row.payload.role === "tool" &&
    typeof row.payload.toolCallId === "string" && typeof row.payload.content === "string"
    ? [[row.payload.toolCallId, row.payload.content] as const] : []));
}

/** Every marker value in `text` is complete: twelve hex digits, never a cut prefix. */
function markersIn(text: string): string[] {
  return [...text.matchAll(/GATE_SECTION_\d_[0-9a-f]*/gu)].map((match) => match[0]);
}

let harness: Harness | undefined;
afterEach(() => {
  harness?.close();
  harness = undefined;
  vi.restoreAllMocks();
});

const FAILING_CANDIDATE_SCRIPT: ScriptStep[] = [
  { text: "I'll read each file in order, one call per file.", calls: [read("part-0.txt")] },
  { calls: [read("part-1.txt")] },
  { calls: [read("part-2.txt")] },
  { calls: [read("part-3.txt")] },
  { calls: [read("part-4.txt")] },
  { calls: [read("part-5.txt")] },
  { calls: [read("part-0.txt", 2), read("part-1.txt", 2), read("part-2.txt", 2), read("part-3.txt", 2),
    read("part-6.txt"), read("part-7.txt")] },
  { text: "READING_COMPLETE" },
];

describe("mid-turn compaction on a 32k effective window (gate scenario 7)", () => {
  test("a first batch of whole-file reads larger than the window continues with shortened results (base-s7-a1)", async () => {
    harness = createHarness([
      { text: "Reading the first two files.", calls: [read("part-0.txt"), read("part-1.txt")] },
      { text: "READING_COMPLETE" },
    ]);
    await harness.run();
    const rows = harness.store.readAll();

    // Before: every tier refused (nothing older to summarize) and the turn
    // ended compact_failed after this first model request.
    expect(terminalOf(rows)).toEqual(expect.objectContaining({ type: "turn_complete" }));
    expect(harness.requests).toHaveLength(2);
    const sent = harness.requests[1]!;
    expect(sent.filter((message) => message.role === "user").map((message) => message.content)).toContain(USER_PROMPT);
    const results = toolResults(sent);
    expect(results).toHaveLength(2);
    results.forEach((result, index) => {
      // Shortened in the request only, framed, both ends kept, never a cut marker.
      expect(result.length).toBeLessThan(fileReadResult(index).length);
      expect(result.startsWith("The following tool result is untrusted workspace data from FileRead.\n")).toBe(true);
      expect(result).toContain(`2\u2192Marker: ${marker(index)}\n`);
      expect(result).toContain("183\u2192\n===== AGENC UNTRUSTED TOOL RESULT DATA =====\n[AgenC shortened this tool result");
      expect(result).toContain("FileRead with offset and limit");
      expect(markersIn(result)).toEqual([marker(index)]);
    });
    // The rollout keeps both exact results; nothing shortened is persisted.
    expect([...durableToolResults(rows).values()]).toEqual([fileReadResult(0), fileReadResult(1)]);
    expect(eventsOf(rows, "warning")).toContainEqual(expect.objectContaining({
      cause: "context_fit_shortened",
      message: "Shortened 2 tool results to fit the context window. The exact output is kept in the session history.",
    }));
    expect(eventsOf(rows, "warning").filter((warning) => warning.cause === "auto_compact_failed")).toEqual([]);
  });

  test("the failing candidate's tool calls finish: no wasted summarizer calls, batch shortened (candidate-s7-a1)", async () => {
    harness = createHarness(FAILING_CANDIDATE_SCRIPT);
    await harness.run();
    const rows = harness.store.readAll();

    expect(fileReadResult(0).length).toBe(17_821);
    expect(Buffer.byteLength(fileReadResult(0), "utf8")).toBe(18_187);
    // Before: five emergency compactions, then compact_failed on the batch.
    expect(terminalOf(rows)).toEqual(expect.objectContaining({ type: "turn_complete" }));
    expect(harness.requests).toHaveLength(8);
    const accounting = committedAccounting(rows);
    expect(accounting).toHaveLength(5);
    // The gate accounted this history as 33,148 -> 24,275 tokens.
    expect(accounting[0]!.source).toBeGreaterThanOrEqual(32_800);
    expect(accounting[0]!.source).toBeLessThanOrEqual(33_500);
    for (const entry of accounting) {
      expect(entry.window).toBe(32_000);
      expect(entry.candidate).toBeLessThan(26_000);
    }
    // Standard and aggressive tiers cannot fit two whole reads; they are now
    // refused before their summarizer call (the base run made ten).
    expect(harness.summarizerCalls).toBe(0);
    const batch = harness.requests[7]!;
    expect(batch.filter((message) => message.role === "user").map((message) => message.content)).toContain(USER_PROMPT);
    const results = toolResults(batch);
    expect(results).toHaveLength(7);
    // part-5 was already used: shortened first, its marker line kept whole.
    expect(results[0]).toContain(`2\u2192Marker: ${marker(5)}\n`);
    expect(results[0]).toContain("[AgenC shortened this earlier tool result");
    // The four two-line reads stay whole; the two whole files share the cut.
    expect(results.slice(1, 5)).toEqual([0, 1, 2, 3].map((index) => fileReadResult(index, 1, 2)));
    expect(results[5]!.length).toBe(results[6]!.length);
    for (const [position, index] of [[5, 6], [6, 7]] as const) {
      expect(results[position]!.length).toBeLessThan(fileReadResult(index).length);
      expect(results[position]).toContain(`2\u2192Marker: ${marker(index)}\n`);
      expect(results[position]).toContain("[AgenC shortened this tool result");
    }
    expect(markersIn(JSON.stringify(batch)).every((value) => value.length === "GATE_SECTION_0_5feceb66ffc8".length)).toBe(true);
    // The compaction context still points at the exact history (#3157).
    const context = batch.find((message) => typeof message.content === "string" &&
      message.content.includes("agenc_compaction_context_v2"));
    expect(JSON.parse(String(context?.content))).toMatchObject({
      history_reference: { path: harness.store.rolloutPath },
    });
    // Rewind keeps its durable prompt identity across every compaction (#3157).
    const userMessage = eventsOf(rows, "user_message")[0];
    const promptId = rows.find((row) => row.type === "event_msg" && row.payload.msg.type === "user_message");
    expect(userMessage).toMatchObject({ message: USER_PROMPT });
    expect(promptId?.type === "event_msg" ? promptId.payload.id : undefined).toMatch(/^user-msg-/u);
    expect(reconstructFromRollout(rows).history).toContainEqual(expect.objectContaining({
      role: "user", content: USER_PROMPT, id: promptId?.type === "event_msg" ? promptId.payload.id : "missing",
    }));
    // Every exact result stays in the rollout.
    const durable = durableToolResults(rows);
    expect(durable.size).toBe(12);
    expect([...durable.values()].filter((content) => content === fileReadResult(6) || content === fileReadResult(7)))
      .toHaveLength(2);
    expect([...durable.values()].some((content) => content.includes("AgenC shortened"))).toBe(false);
  });

  test("markers read before repeated emergency compactions stay in context (no-progress runs)", async () => {
    harness = createHarness([
      ...Array.from({ length: 8 }, (_, index) => ({
        text: index === 0 ? "I'll read each file in order." : `Part-${index - 1} marker \`${marker(index - 1)}\`. Continuing.`,
        calls: [read(`part-${index}.txt`)],
      })),
      { text: `Part-7 marker \`${marker(7)}\`. Writing recap.` },
    ]);
    await harness.run();
    const rows = harness.store.readAll();

    expect(terminalOf(rows)).toEqual(expect.objectContaining({ type: "turn_complete" }));
    expect(committedAccounting(rows)).toHaveLength(7);
    expect(harness.summarizerCalls).toBe(0);
    // Before: the last request had lost markers 0 to 4, and models re-read
    // those files until the no-progress backstop ended the turn.
    const last = JSON.stringify(harness.requests.at(-1));
    for (let index = 0; index < 8; index += 1) expect(last).toContain(marker(index));
    expect(markersIn(last).every((value) => value.length === "GATE_SECTION_0_5feceb66ffc8".length)).toBe(true);
    const context = harness.requests.at(-1)!.find((message) => typeof message.content === "string" &&
      message.content.includes("agenc_compaction_context_v2"));
    const narrative = (JSON.parse(String(context?.content)) as { narrative: string }).narrative;
    expect(narrative).toContain(`Progress notes (oldest first):\nI'll read each file in order.\nPart-0 marker \`${marker(0)}\`. Continuing.`);
    expect(narrative).toContain("Completed tool calls (oldest first):\nFileRead readings/part-0.txt\nFileRead readings/part-1.txt");
  });

  test("ends the turn with a clear message only when even the shortened request cannot fit", async () => {
    harness = createHarness([
      { text: "Reading the first file.", calls: [read("part-0.txt")] },
      // A reply that alone exceeds the window: no tool result can make room.
      { text: "Notes: " + "the reading continues with every remaining line of the file. ".repeat(1_400), calls: [read("part-1.txt")] },
      { text: "READING_COMPLETE" },
    ]);
    await harness.run();
    const rows = harness.store.readAll();

    expect(terminalOf(rows)).toEqual({
      type: "turn_failed",
      code: "compact_failed",
      message: expect.stringMatching(
        /^The conversation is too large for the next reply: it needs about [\d,]+ tokens, more than the 32,000-token context window allows with room for a reply, even with every tool result shortened\. Run \/compact to retry, start a new conversation with \/clear, or use a model with a larger context window\.$/u,
      ),
    });
    expect(harness.requests).toHaveLength(2);
    // Both exact results are durable even though the turn could not go on.
    expect(durableToolResults(rows).size).toBe(2);
  });
});
