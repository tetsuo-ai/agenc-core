// Anthropic fast mode bills 2x (Opus 5.5 $8/$40, fast-mode doc 2026-09-22).
// Under a hard cost cap the reservation must cover a fast turn, and the
// reconciled charge must follow the speed the API reports it served.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { AnthropicProvider } from "../../src/llm/providers/anthropic/adapter.js";
import type { LLMMessage } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function messagesStream(servedSpeed: "fast" | "standard"): Response {
  return sseResponse([
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_${servedSpeed}","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":1000,"output_tokens":0,"speed":"${servedSpeed}"}}}\n\n`,
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":100,"speed":"${servedSpeed}"}}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
}

const SINGLE_SLOT_LIMITS = { global: 1, workspace: 1, session: 1, parent: 1, provider: 1 } as const;

// Scratch kernel bound to a single-slot client, the fixture every synthetic
// admission probe in this file starts from.
function createSyntheticAdmissionClient(directory: string, ownerId: string, runId: string) {
  const workspace = join(directory, "workspace");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  const kernel = new ExecutionAdmissionKernel({
    agencHome: join(directory, "home"),
    ownerId,
    ownerPid: process.pid,
    limits: SINGLE_SLOT_LIMITS,
  });
  const client = kernel.bindClient({
    cwd: workspace,
    scope: { runId, sessionId: runId, autonomous: false, maxCostUsd: 10 },
  });
  return { kernel, client };
}

async function admittedCall(params: {
  readonly serviceTier?: "priority";
  readonly servedSpeed: "fast" | "standard";
}): Promise<{ readonly reservedUsd: number; readonly chargedUsd: number }> {
  const directory = mkdtempSync(join(tmpdir(), "agenc-anthropic-fast-admission-"));
  const { kernel, client } = createSyntheticAdmissionClient(directory, "anthropic-fast-admission", "fast-admission");
  const acquire = vi.spyOn(client, "acquire");
  const reconcile = vi.spyOn(client, "reconcile");
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) =>
    String(input).endsWith("/messages/count_tokens")
      ? new Response(JSON.stringify({ input_tokens: 1000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
      : messagesStream(params.servedSpeed));
  const model = "claude-opus-5-5";
  const messages: LLMMessage[] = [{ role: "user", content: "synthetic probe" }];
  const provider = new AnthropicProvider({ apiKey: "anthropic-test", model, fetchImpl });
  const session = {
    conversationId: "fast-admission",
    services: { executionAdmission: client, admissionRequired: true, agentControl: {} },
    abortTerminal: vi.fn(),
  } as unknown as Session;
  try {
    await runAdmittedModelCall({
      session, provider, messages, stepId: "fast", model, providerName: "anthropic",
      options: {
        maxOutputTokens: 1000,
        contextWindowTokens: 1_000_000,
        ...(params.serviceTier !== undefined ? { serviceTier: params.serviceTier } : {}),
      },
      invoke: (options) => provider.chatStream(messages, () => undefined, options),
    });
    const reservedUsd = acquire.mock.calls[0]?.[0].maxCostUsd;
    const chargedUsd = reconcile.mock.calls[0]?.[1].costUsd;
    if (typeof reservedUsd !== "number" || typeof chargedUsd !== "number") {
      throw new Error("the admitted call did not reserve and reconcile a priced turn");
    }
    return { reservedUsd, chargedUsd };
  } finally {
    kernel.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a fast-mode Opus 5.5 turn reserves and is charged at fast-mode rates", async () => {
  const standard = await admittedCall({ servedSpeed: "standard" });
  const fast = await admittedCall({ serviceTier: "priority", servedSpeed: "fast" });
  // 1000 input and 100 output tokens: $0.004 + $0.002 standard, twice that fast.
  expect(standard.chargedUsd).toBeCloseTo(0.006, 9);
  expect(fast.chargedUsd).toBeCloseTo(0.012, 9);
  // The same request asking for fast mode reserves at the fast rates.
  expect(fast.reservedUsd).toBeCloseTo(standard.reservedUsd * 2, 9);
  expect(fast.chargedUsd).toBeLessThanOrEqual(fast.reservedUsd);
});

test("a fast request served at standard speed is charged at standard rates", async () => {
  const servedStandard = await admittedCall({ serviceTier: "priority", servedSpeed: "standard" });
  const standard = await admittedCall({ servedSpeed: "standard" });
  expect(servedStandard.chargedUsd).toBeCloseTo(0.006, 9);
  // The reservation still covered the fast rates the request asked for.
  expect(servedStandard.reservedUsd).toBeCloseTo(standard.reservedUsd * 2, 9);
});
