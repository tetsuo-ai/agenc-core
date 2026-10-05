import { vi } from "vitest";
import type { AdmissionAcquireInput, ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import type { LLMChatOptions, LLMResponse, StreamProgressCallback } from "../../src/llm/types.js";
import { mkProvider } from "../fixtures.js";

export const answer: LLMResponse = {
  content: "The answer is ready.", toolCalls: [], model: "test-model", finishReason: "stop",
  usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120,
    availability: "reported", provenance: "provider" },
};

export const alternatingSummary = [
  "Let me know if you want to tweak anything! ",
  "I can adjust the implementation if you would like any changes. ",
];

export type Sample = (emit: StreamProgressCallback, options: LLMChatOptions) => Promise<LLMResponse>;

export function scriptedProvider(samples: Sample[]) {
  const provider = mkProvider();
  let calls = 0;
  provider.chatStream = async (_messages, emit, options = {}) => {
    const sample = samples[Math.min(calls++, samples.length - 1)]!;
    return sample(emit, options);
  };
  return { provider, calls: () => calls };
}

/** Settles only after observing abort, like an adapter closing its iterator. */
export function repeatingSample(options: { delayMs?: number; lateUsage?: boolean; fragment?: boolean } = {}): Sample {
  return (emit, request) => new Promise((resolve, reject) => {
    let index = 0;
    const fragments = options.fragment ? alternatingSummary.join("").split("") : alternatingSummary;
    const timer = setInterval(() => {
      const delta = fragments[index % fragments.length]!;
      emit({ content: "", done: false,
        reasoningSummaryDelta: { delta, summaryIndex: index++ % 2 } });
    }, options.delayMs ?? 10);
    const abort = () => {
      clearInterval(timer);
      if (options.lateUsage) resolve({ ...answer, content: "" });
      else reject(request.signal?.reason);
    };
    if (request.signal?.aborted) abort();
    else request.signal?.addEventListener("abort", abort, { once: true });
  });
}

export const goodSample: Sample = async (emit) => {
  emit({ content: answer.content, done: true });
  return answer;
};

/**
 * Synthetic engineering reasoning trace: multi-file invariants, arithmetic,
 * repeated checklists, code and revisions. No captured/private model data.
 * Over 32k tokens at 4 chars/token and over an hour at 20 s per section.
 */
export function longReasoningTrace(): string[] {
  return Array.from({ length: 200 }, (_, i) => {
    const rows = 101 + i * 17;
    return `I am checking partition ${i} of the migration before deciding whether the worker can acknowledge its batch.
The previous checkpoint contains ${rows} records, while the new page contains ${rows + 13}. That means thirteen records need validation; the checkpoint itself must remain unchanged until commit succeeds.
The invariant is that each durable effect has one receipt. I need to separate a missing receipt from a receipt whose result was lost during delivery. Retrying the latter blindly could repeat a payment.
For case ${i}, the query uses tenant_${i} and cursor_${rows}. The predicate is tenant_id = $1 AND sequence > $2; it needs a composite index, because an index on sequence alone mixes tenants.
Let me test the boundary in both directions. With limit ${i + 8}, the last item has sequence ${rows + i + 8}. The next page must start strictly after it. Replacing > with >= would duplicate that item, while adding one before querying can skip gaps.
The cancellation path closes the iterator in finally. A completed transaction remains committed even if the client disconnects. I should assert the receipt count and the next cursor, rather than relying on a log line that merely says success.
I initially considered storing an in-memory seen set for this partition. That would not survive restart, so the durable uniqueness constraint on (tenant_${i}, effect_id) is the useful authority here.
Now I can move to the next partition with checkpoint ${rows + 13}; its input differs, but the same commit and cancellation rules still apply.\n`;
  });
}

/** Records durable settlement and physical completion without faking refunds. */
export function recordingAdmission() {
  const order: string[] = [];
  const client = {
    scope: { runId: "run-progress", workspaceId: "workspace", sessionId: "conv-test", autonomous: false },
    acquire: vi.fn(async (input: AdmissionAcquireInput, signal?: AbortSignal) => {
      const id = input.stepId;
      order.push(`acquire:${id}`);
      return {
        decision: "allow", signal,
        reservation: { reservationId: id },
        request: { estimate: { maxOutputTokens: input.maxOutputTokens } },
      };
    }),
    markDispatched: vi.fn(),
    reconcile: vi.fn((id: string) => { order.push(`reconcile:${id}`); return { applied: true, outcome: "reconciled" }; }),
    holdUnknown: vi.fn((id: string) => order.push(`unknown:${id}`)),
    void: vi.fn(),
    acknowledgeCompletion: vi.fn((id: string) => order.push(`complete:${id}`)),
    recordFallback: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  };
  return { client: client as unknown as ExecutionAdmissionClient, spies: client, order };
}
