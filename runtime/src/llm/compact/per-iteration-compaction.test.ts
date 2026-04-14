/**
 * Phase A acceptance test: the layered compaction chain composes
 * snip → microcompact → autocompact in the expected order, threads
 * state forward, and accumulates boundary messages for telemetry.
 *
 * These tests exercise the orchestrator directly. The live loop
 * wiring in `chat-executor-tool-loop.ts` is covered by the existing
 * `chat-executor.test.ts` regression suite (which still passes after
 * the wiring lands — if it regresses, the orchestrator signature or
 * the state-threading rule broke).
 */

import { describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../types.js";
import {
  applyPerIterationCompaction,
  createPerIterationCompactionState,
  DEFAULT_SNIP_GAP_MS,
  DEFAULT_MICROCOMPACT_GAP_MS,
} from "./index.js";

const T0 = 1_000_000_000;

function makeAssistant(content: string): LLMMessage {
  return { role: "assistant", content };
}

function makeUser(content: string): LLMMessage {
  return { role: "user", content };
}

function makeMultimodalUser(content: string, imageUrl: string): LLMMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: content },
      { type: "image_url", image_url: { url: imageUrl } },
    ],
  };
}

function makeToolResult(id: string, size: number): LLMMessage {
  return {
    role: "tool",
    tool_call_id: id,
    content: "x".repeat(size),
  } as LLMMessage;
}

describe("applyPerIterationCompaction", () => {
  it("noops on first call (all layers see lastTouchMs=0)", () => {
    const state = createPerIterationCompactionState();
    const messages = [makeUser("hi"), makeAssistant("hello")];

    const result = applyPerIterationCompaction({
      messages,
      state,
      nowMs: T0,
    });

    expect(result.action).toBe("noop");
    expect(result.messages).toBe(messages);
    expect(result.boundaries).toEqual([]);
    expect(result.preservedAttachments).toEqual([]);
    // State timestamps updated even on noop so the next call has a
    // baseline to compute idleness against.
    expect(result.state.snip.lastTouchMs).toBe(T0);
    expect(result.state.microcompact.lastTouchMs).toBe(T0);
  });

  it("noops inside a single active iteration when nothing is idle", () => {
    let state = createPerIterationCompactionState();

    // Warm up: first call baselines the timestamps.
    state = applyPerIterationCompaction({
      messages: [makeUser("warmup")],
      state,
      nowMs: T0,
    }).state;

    // Follow-up call ~50ms later should noop on every layer.
    const result = applyPerIterationCompaction({
      messages: [
        makeUser("warmup"),
        makeAssistant("ok"),
        makeUser("next"),
      ],
      state,
      nowMs: T0 + 50,
    });

    expect(result.action).toBe("noop");
    expect(result.boundaries).toEqual([]);
    expect(result.preservedAttachments).toEqual([]);
  });

  it("snips after the snip gap elapses on a long history", () => {
    let state = createPerIterationCompactionState();
    // Seed state with a prior touch so `lastTouchMs !== 0`.
    state = applyPerIterationCompaction({
      messages: [makeUser("seed")],
      state,
      nowMs: T0,
    }).state;

    // Build a history long enough to exceed keepRecent (default 40)
    // and advance the clock past DEFAULT_SNIP_GAP_MS so snip fires.
    const longHistory: LLMMessage[] = [];
    for (let i = 0; i < 60; i++) {
      longHistory.push(makeUser(`q${i}`), makeAssistant(`a${i}`));
    }

    const result = applyPerIterationCompaction({
      messages: longHistory,
      state,
      nowMs: T0 + DEFAULT_SNIP_GAP_MS + 1,
    });

    expect(result.action).toBe("compacted");
    expect(result.messages.length).toBeLessThan(longHistory.length);
    const snipBoundary = result.boundaries.find(
      (m) =>
        typeof m.content === "string" && m.content.startsWith("[snip]"),
    );
    expect(snipBoundary).toBeDefined();
    expect(result.state.snip.snipCount).toBe(1);
  });

  it("surfaces preserved attachments when snip drops a multimodal message", () => {
    let state = createPerIterationCompactionState();
    state = applyPerIterationCompaction({
      messages: [makeUser("seed")],
      state,
      nowMs: T0,
    }).state;

    const attachmentMessage = makeMultimodalUser(
      "see this",
      "https://example.com/asset.png",
    );
    const history: LLMMessage[] = [attachmentMessage];
    for (let i = 0; i < 45; i++) {
      history.push(makeUser(`q${i}`), makeAssistant(`a${i}`));
    }

    const result = applyPerIterationCompaction({
      messages: history,
      state,
      nowMs: T0 + DEFAULT_SNIP_GAP_MS + 1,
    });

    expect(result.action).toBe("compacted");
    expect(result.messages).not.toContain(attachmentMessage);
    expect(result.preservedAttachments).toHaveLength(1);
    expect(result.preservedAttachments[0]).toMatchObject({
      messageIndex: 0,
      role: "user",
      content: attachmentMessage.content,
    });
  });

  it("microcompacts cold tool results after the microcompact gap", () => {
    let state = createPerIterationCompactionState();

    // Seed microcompact state.
    state = applyPerIterationCompaction({
      messages: [makeUser("seed")],
      state,
      nowMs: T0,
    }).state;

    // Build a history with several old tool results and a few
    // recent messages (microcompact preserves the last 6).
    const messages: LLMMessage[] = [
      makeUser("q1"),
      makeToolResult("call-1", 2000),
      makeUser("q2"),
      makeToolResult("call-2", 2000),
      makeUser("q3"),
      makeToolResult("call-3", 2000),
      makeUser("q4"),
      makeToolResult("call-4", 2000),
      makeUser("q5"),
      makeAssistant("recent-1"),
      makeAssistant("recent-2"),
      makeAssistant("recent-3"),
      makeAssistant("recent-4"),
      makeAssistant("recent-5"),
      makeAssistant("recent-6"),
    ];

    const result = applyPerIterationCompaction({
      messages,
      state,
      // Advance far enough for microcompact to trigger but NOT for
      // snip (snip would then swallow the test's intent). Snip gap
      // is much larger than microcompact gap in the defaults.
      nowMs: T0 + DEFAULT_MICROCOMPACT_GAP_MS + 10,
    });

    expect(result.action).toBe("compacted");
    const microBoundary = result.boundaries.find(
      (m) =>
        typeof m.content === "string" &&
        m.content.startsWith("[microcompact]"),
    );
    expect(microBoundary).toBeDefined();
    // Cold tool result bodies should be replaced with the placeholder.
    const placeholderHits = result.messages.filter(
      (m) =>
        m.role === "tool" &&
        typeof m.content === "string" &&
        m.content.startsWith("[microcompact]"),
    );
    expect(placeholderHits.length).toBeGreaterThan(0);
  });

  it("flags autocompact as decision-only (messages unchanged)", () => {
    const state = createPerIterationCompactionState();
    // Build a synthetic history far above the default threshold.
    // tokenCountWithEstimation sums up the character length / 4 plus
    // a small per-message overhead, so a single ~200K char message
    // will sit well above the default threshold (~150K tokens).
    const huge = "x".repeat(800_000);
    const messages = [makeUser("q"), makeAssistant(huge)];

    const result = applyPerIterationCompaction({
      messages,
      state,
      nowMs: T0,
      autocompactThresholdTokens: 1_000,
    });

    expect(result.action).toBe("compacted");
    // autocompact does NOT prune messages — that's the caller's
    // summarizer. The orchestrator returns the message list unchanged.
    expect(result.messages).toBe(messages);
    const autoBoundary = result.boundaries.find(
      (m) =>
        typeof m.content === "string" &&
        m.content.startsWith("[autocompact]"),
    );
    expect(autoBoundary).toBeDefined();
  });

  it("threads state forward across calls (second call sees first call's touches)", () => {
    const initial = createPerIterationCompactionState();

    const first = applyPerIterationCompaction({
      messages: [makeUser("a"), makeAssistant("b")],
      state: initial,
      nowMs: T0,
    });
    expect(first.state.snip.lastTouchMs).toBe(T0);

    const second = applyPerIterationCompaction({
      messages: [
        makeUser("a"),
        makeAssistant("b"),
        makeUser("c"),
      ],
      state: first.state,
      nowMs: T0 + 100,
    });
    // Second call is not idle enough for snip/microcompact to fire,
    // but the state must still advance the clock.
    expect(second.state.snip.lastTouchMs).toBe(T0 + 100);
  });

  it("invokes the optional consolidation hook when supplied (Phase N)", () => {
    const state = createPerIterationCompactionState();
    const messages: LLMMessage[] = [
      makeUser("discuss"),
      makeAssistant("sure"),
    ];
    const summaryMessage: LLMMessage = {
      role: "system",
      content: "[consolidation] recurring topics: alpha, beta",
    };
    const hook = vi.fn(() => ({
      action: "consolidated" as const,
      summaryMessage,
    }));
    const result = applyPerIterationCompaction({
      messages,
      state,
      nowMs: T0,
      consolidationHook: hook,
    });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(result.action).toBe("compacted");
    expect(result.boundaries.some((m) => m === summaryMessage)).toBe(true);
  });

  it("skips consolidation when the hook reports noop", () => {
    const state = createPerIterationCompactionState();
    const messages: LLMMessage[] = [
      makeUser("short"),
      makeAssistant("ok"),
    ];
    const hook = vi.fn(() => ({ action: "noop" as const }));
    const result = applyPerIterationCompaction({
      messages,
      state,
      nowMs: T0,
      consolidationHook: hook,
    });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(result.action).toBe("noop");
  });

  it("accumulates boundaries in layer order (snip before microcompact before autocompact)", () => {
    let state = createPerIterationCompactionState();
    // Seed state.
    state = applyPerIterationCompaction({
      messages: [makeUser("seed")],
      state,
      nowMs: T0,
    }).state;

    // Build a history that triggers all three layers in one shot:
    //   - long enough for snip (> keepRecent)
    //   - contains old tool results for microcompact
    //   - huge enough after snip to still exceed autocompact threshold
    const history: LLMMessage[] = [];
    for (let i = 0; i < 60; i++) {
      history.push(makeUser(`u${i}`));
      history.push(makeToolResult(`call-${i}`, 3000));
      history.push(makeAssistant(`a${i}`));
    }

    const result = applyPerIterationCompaction({
      messages: history,
      state,
      nowMs: T0 + DEFAULT_SNIP_GAP_MS + 1,
      autocompactThresholdTokens: 1_000,
    });

    expect(result.action).toBe("compacted");
    // At least one of each layer's boundary should be present, and
    // they should appear in orchestrator order.
    const tags = result.boundaries
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .map((c) => c.match(/^\[([a-z_-]+)\]/)?.[1] ?? "?");
    expect(tags).toContain("snip");
    expect(tags).toContain("autocompact");
    // Relative order: snip before microcompact before autocompact when all fire.
    const snipIdx = tags.indexOf("snip");
    const autoIdx = tags.indexOf("autocompact");
    expect(snipIdx).toBeLessThan(autoIdx);
  });
});
