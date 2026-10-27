import { describe, expect, test } from "vitest";

import {
  TOKEN_ACCOUNTING_ANCHORED_CALIBRATION_HEADROOM,
  TOKEN_ACCOUNTING_ANCHORED_CALIBRATION_MIN_FACTOR,
  TOKEN_ACCOUNTING_ANCHORED_CALIBRATION_SAMPLES,
  TOKEN_ACCOUNTING_CALIBRATION_HEADROOM,
  TokenAccountingService,
  conservativeBytesPerToken,
  createTokenAccountingRequest,
  estimateTokenAccountingRequest,
  reportedPromptTokensFromContextOverflow,
  reportsCompletePromptTokens,
  type CreateTokenAccountingRequestOptions,
  type TokenAccountingResult,
} from "../../src/llm/token-accounting.js";
import type { LLMMessage, LLMTool } from "../../src/llm/types.js";

const HEADROOM = TOKEN_ACCOUNTING_ANCHORED_CALIBRATION_HEADROOM;
// DeepSeek's prompt tokens per conservative-fallback token in recorded requests (the fallback was 2.45x).
const DEEPSEEK_RATIO = 1 / 2.45;

const SYSTEM_PROMPT = "You are AgenC, an autonomous coding agent. Use the tools to read and change files.\n".repeat(120);
const TOOLS: LLMTool[] = ["FileRead", "exec_command", "Edit"].map((name) => ({
  type: "function" as const,
  function: {
    name,
    description: `${name}: one precise operation; paths are absolute.`,
    parameters: { type: "object", properties: { file_path: { type: "string" } }, required: [] },
  },
}));

function prose(lines: number, label = "record"): string {
  return Array.from({ length: lines }, (_, line) =>
    `Line ${line}: ${label} ${line} describes cedar meadow lantern orbit parcel canyon violet station.`,
  ).join("\n");
}

/** Minified JSON with ids and numbers: the dense structured input the fallback floor exists for. */
function denseJson(entries: number): string {
  return JSON.stringify(Array.from({ length: entries }, (_, index) => ({
    id: `${(index * 2_654_435_761 >>> 0).toString(16)}${index.toString(36)}`,
    v: [index, index * 7 % 13, -index / 8],
    ok: index % 3 === 0,
  })));
}

function readTurn(id: string, content: string): LLMMessage[] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id, name: "FileRead", arguments: `{"file_path":"/w/${id}"}` }] },
    { role: "tool", toolCallId: id, content },
  ];
}

const HISTORY: LLMMessage[] = [
  { role: "user", content: "Read the reports and summarize the markers." },
  ...readTurn("call-1", prose(180)),
];

function request(
  messages: readonly LLMMessage[],
  overrides: Partial<CreateTokenAccountingRequestOptions> = {},
) {
  return createTokenAccountingRequest({
    provider: "deepseek",
    model: "deepseek-flash",
    calibrationScope: "conv-a",
    endpointIdentity: "https://api.deepseek.com",
    messages: [...messages],
    options: { systemPrompt: SYSTEM_PROMPT, tools: TOOLS, maxOutputTokens: 8_192 },
    contextWindowTokens: 1_048_576,
    reservedOutputTokens: 8_192,
    ...overrides,
  });
}

function fallbackOf(messages: readonly LLMMessage[], overrides: Partial<CreateTokenAccountingRequestOptions> = {}): number {
  return estimateTokenAccountingRequest(request(messages, overrides)).inputTokens;
}

/** Counts a request and reports `ratio` x its fallback as the provider's prompt tokens. */
async function reportAt(
  service: TokenAccountingService,
  messages: readonly LLMMessage[],
  ratio: number,
  overrides: Partial<CreateTokenAccountingRequestOptions> = {},
): Promise<{ readonly result: TokenAccountingResult; readonly basis: number; readonly reported: number }> {
  const result = await service.count(request(messages, overrides));
  const basis = fallbackOf(messages, overrides);
  const reported = Math.max(1, Math.round(basis * ratio));
  service.recordProviderUsage(result, reported);
  return { result, basis, reported };
}

describe("two-way calibration from DeepSeek reported prompt tokens", () => {
  test("a report lowers the next estimate of the conversation to the measured size plus headroom", async () => {
    const service = new TokenAccountingService();
    const anchor = await reportAt(service, HISTORY, DEEPSEEK_RATIO);
    expect(anchor.result.inputTokens).toBe(anchor.basis);
    expect(anchor.result.calibration).toBeUndefined();

    const grown = [...HISTORY, ...readTurn("call-2", prose(20, "entry"))];
    const fallback = fallbackOf(grown);
    const next = await service.count(request(grown));

    const ratio = anchor.reported / anchor.basis;
    expect(next.source).toBe("conservative_fallback");
    expect(next.inputTokens).toBe(Math.ceil(anchor.basis * (ratio * HEADROOM) + (fallback - anchor.basis)));
    expect(next.inputTokens).toBeGreaterThanOrEqual(Math.ceil(anchor.reported * HEADROOM));
    expect(next.inputTokens).toBeLessThan(fallback * 0.6);
    expect(next.totalTokens).toBe(next.inputTokens + next.reservedOutputTokens);
    expect(next.calibration).toEqual({
      factor: ratio,
      basisInputTokens: fallback,
      headroom: HEADROOM,
      anchorBasisInputTokens: anchor.basis,
    });
  });

  test("what grew since the report keeps the fallback rate, so dense JSON input is not scaled down", async () => {
    const service = new TokenAccountingService();
    const anchor = await reportAt(service, HISTORY, DEEPSEEK_RATIO);
    const json = denseJson(1_500);
    const grown = [...HISTORY, ...readTurn("call-2", json)];
    const fallback = fallbackOf(grown);

    const next = await service.count(request(grown));

    // The measured history is anchored on the report; the new JSON keeps the
    // conservative bound of two bytes per token plus the fallback margin.
    expect(next.inputTokens).toBe(
      Math.ceil(anchor.basis * ((anchor.reported / anchor.basis) * HEADROOM) + (fallback - anchor.basis)),
    );
    expect(next.inputTokens - Math.ceil(anchor.reported * HEADROOM)).toBeGreaterThan(
      Buffer.byteLength(json, "utf8") / conservativeBytesPerToken("deepseek", "deepseek-flash"),
    );
    expect(next.inputTokens).toBeLessThan(fallback);
  });

  test("a shrunk request, as after compaction, is estimated at the measured ratio", async () => {
    const service = new TokenAccountingService();
    const long = [...HISTORY, ...readTurn("call-2", prose(400, "entry")), ...readTurn("call-3", prose(400, "item"))];
    const anchor = await reportAt(service, long, DEEPSEEK_RATIO);
    const compacted: LLMMessage[] = [
      { role: "user", content: `Summary of earlier work: ${prose(10, "note")}` },
      ...readTurn("call-4", prose(30, "tail")),
    ];
    const fallback = fallbackOf(compacted);

    const next = await service.count(request(compacted));

    expect(next.inputTokens).toBe(Math.ceil(fallback * ((anchor.reported / anchor.basis) * HEADROOM)));
  });

  test("the first request and every other conversation, request shape, endpoint or model keep the conservative fallback", async () => {
    const service = new TokenAccountingService();
    const first = await service.count(request(HISTORY));
    expect(first.inputTokens).toBe(fallbackOf(HISTORY));
    service.recordProviderUsage(first, Math.round(first.inputTokens * DEEPSEEK_RATIO));

    for (const overrides of [
      { calibrationScope: "conv-b" },
      { calibrationScope: undefined },
      // A tool-free side call (the compaction summarizer, a classifier) of the same conversation.
      { options: { systemPrompt: "You summarize transcripts.", maxOutputTokens: 8_192 } },
      { options: { systemPrompt: SYSTEM_PROMPT, maxOutputTokens: 8_192 } },
      { endpointIdentity: "https://other.example/v1" },
      { model: "deepseek-pro" },
    ] satisfies Partial<CreateTokenAccountingRequestOptions>[]) {
      const other = await service.count(request(HISTORY, overrides));
      expect(other.inputTokens).toBe(fallbackOf(HISTORY, overrides));
      expect(other.calibration).toBeUndefined();
    }
  });

  test("a system prompt the runtime extends within the conversation keeps the calibration", async () => {
    const service = new TokenAccountingService();
    const anchor = await reportAt(service, HISTORY, DEEPSEEK_RATIO);
    // A compaction appends its continuation note to the agent turn's instructions.
    const extended = {
      options: {
        systemPrompt: `${SYSTEM_PROMPT}\n\nCompaction continuation: resume the unfinished step using retained tool results.`,
        tools: TOOLS,
        maxOutputTokens: 8_192,
      },
    };
    const fallback = fallbackOf(HISTORY, extended);

    const next = await service.count(request(HISTORY, extended));

    expect(next.calibration?.anchorBasisInputTokens).toBe(anchor.basis);
    expect(next.inputTokens).toBe(Math.ceil(
      anchor.basis * ((anchor.reported / anchor.basis) * HEADROOM) + (fallback - anchor.basis),
    ));
  });

  test("the ratio is the largest of the newest reports, so an old dense request ages out", async () => {
    const service = new TokenAccountingService();
    const basis = fallbackOf(HISTORY);
    await reportAt(service, HISTORY, 0.6);
    for (let index = 1; index < TOKEN_ACCOUNTING_ANCHORED_CALIBRATION_SAMPLES; index += 1) {
      await reportAt(service, HISTORY, 0.4);
    }
    expect((await service.count(request(HISTORY))).inputTokens)
      .toBe(Math.ceil(basis * ((Math.round(basis * 0.6) / basis) * HEADROOM)));

    await reportAt(service, HISTORY, 0.4);

    expect((await service.count(request(HISTORY))).inputTokens)
      .toBe(Math.ceil(basis * ((Math.round(basis * 0.4) / basis) * HEADROOM)));
  });

  test("an implausibly low report keeps the minimum share of the fallback", async () => {
    const service = new TokenAccountingService();
    const first = await service.count(request(HISTORY));
    service.recordProviderUsage(first, 1);

    const next = await service.count(request(HISTORY));

    expect(next.inputTokens).toBe(
      Math.ceil(first.inputTokens * (TOKEN_ACCOUNTING_ANCHORED_CALIBRATION_MIN_FACTOR * HEADROOM)),
    );
  });

  test("a report above the fallback still raises the estimate, at least as far as upward calibration did", async () => {
    const service = new TokenAccountingService();
    const anchor = await reportAt(service, HISTORY, 1.3);
    const ratio = anchor.reported / anchor.basis;

    const next = await service.count(request(HISTORY));

    expect(next.inputTokens).toBe(Math.ceil(anchor.basis * (ratio * HEADROOM)));
    expect(next.inputTokens).toBeGreaterThanOrEqual(
      Math.ceil(anchor.basis * ratio * TOKEN_ACCOUNTING_CALIBRATION_HEADROOM),
    );
  });

  test("a report another request shape raised above the fallback still bounds the main request", async () => {
    const service = new TokenAccountingService();
    const main = await reportAt(service, HISTORY, DEEPSEEK_RATIO);
    // A side call of the same conversation with its own system prompt that the fallback undercounted.
    const side = await reportAt(service, [{ role: "user", content: prose(40) }], 1.5, {
      options: { systemPrompt: "You classify requests.", maxOutputTokens: 8_192 },
    });

    const next = await service.count(request(HISTORY));

    expect(next.inputTokens).toBe(
      Math.ceil(main.basis * (side.reported / side.basis) * TOKEN_ACCOUNTING_CALIBRATION_HEADROOM),
    );
  });

  test("endpoints whose reports can undercount keep upward-only calibration", async () => {
    expect(reportsCompletePromptTokens("deepseek", "deepseek-flash")).toBe(true);
    expect(reportsCompletePromptTokens("DeepSeek", "deepseek-pro")).toBe(true);
    for (const [provider, model] of [
      ["ollama", "deepseek-r1:8b"],
      ["lmstudio", "deepseek-coder"],
      ["openrouter", "deepseek/deepseek-chat"],
      ["openai", "gpt-6-luna"],
      ["test-provider", "test-model"],
    ] as const) {
      expect(reportsCompletePromptTokens(provider, model)).toBe(false);
      const service = new TokenAccountingService();
      const overrides = { provider, model };
      const first = await service.count(request(HISTORY, overrides));
      service.recordProviderUsage(first, Math.round(first.inputTokens * DEEPSEEK_RATIO));
      const next = await service.count(request(HISTORY, overrides));
      expect(next.inputTokens).toBe(fallbackOf(HISTORY, overrides));
    }
  });

  test("usage that teaches nothing (provider-native tool turns, zero) leaves the fallback", async () => {
    const service = new TokenAccountingService();
    const first = await service.count(request(HISTORY));
    service.recordProviderUsage(first, Math.round(first.inputTokens * DEEPSEEK_RATIO), { calibrate: false });
    service.recordProviderUsage(first, 0);

    expect((await service.count(request(HISTORY))).inputTokens).toBe(fallbackOf(HISTORY));
  });

  test("a context-length refusal that states the prompt size re-anchors the conversation on it", async () => {
    const service = new TokenAccountingService();
    await reportAt(service, HISTORY, DEEPSEEK_RATIO);
    const grown = [...HISTORY, ...readTurn("call-2", prose(60, "entry"))];
    const admitted = await service.count(request(grown));
    const fallback = fallbackOf(grown);
    const refused = Math.round(fallback * 0.7);

    service.recordContextOverflow(
      admitted,
      `This model's maximum context length is 65536 tokens. However, you requested ${refused + 8_192} tokens ` +
        `(${refused} in the messages, 8192 in the completion). Please reduce the length of the messages or completion.`,
    );

    expect((await service.count(request(grown))).inputTokens)
      .toBe(Math.ceil(fallback * ((refused / fallback) * HEADROOM)));
  });

  test("a context-length refusal without a size drops two-way calibration until the next report", async () => {
    const service = new TokenAccountingService();
    await reportAt(service, HISTORY, DEEPSEEK_RATIO);
    const admitted = await service.count(request(HISTORY));
    expect(admitted.inputTokens).toBeLessThan(fallbackOf(HISTORY));

    service.recordContextOverflow(admitted, "context_length_exceeded");

    expect((await service.count(request(HISTORY))).inputTokens).toBe(fallbackOf(HISTORY));
  });

  test("clearing the service or evicting the conversation drops two-way calibration", async () => {
    const service = new TokenAccountingService({ calibrationMaxScopes: 1 });
    await reportAt(service, HISTORY, DEEPSEEK_RATIO);
    await reportAt(service, HISTORY, DEEPSEEK_RATIO, { calibrationScope: "conv-b" });

    expect((await service.count(request(HISTORY))).inputTokens).toBe(fallbackOf(HISTORY));
    expect((await service.count(request(HISTORY, { calibrationScope: "conv-b" }))).inputTokens)
      .toBeLessThan(fallbackOf(HISTORY));
    service.clear();
    expect((await service.count(request(HISTORY, { calibrationScope: "conv-b" }))).inputTokens)
      .toBe(fallbackOf(HISTORY));
  });
});

test("reads the prompt size a context-length refusal reports", () => {
  expect(reportedPromptTokensFromContextOverflow(
    "This model's maximum context length is 1048576 tokens. However, you requested 1056296 tokens (672296 in the messages, 384000 in the completion).",
  )).toBe(672_296);
  expect(reportedPromptTokensFromContextOverflow("context_length_exceeded")).toBeUndefined();
  expect(reportedPromptTokensFromContextOverflow("(0 in the messages)")).toBeUndefined();
});
