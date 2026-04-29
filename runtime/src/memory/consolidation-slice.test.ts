/**
 * Phase N acceptance test: `consolidateEpisodicSlice` produces a
 * deterministic summary of a message window for the layered
 * compaction chain, with no LLM call and no memory backend access.
 */

import { describe, expect, it } from "vitest";
import { consolidateEpisodicSlice } from "./consolidation.js";
import type { LLMMessage } from "../llm/types.js";

function msgs(count: number, seed: string): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `${seed} iteration ${i} with token${i % 3}`,
    });
  }
  return out;
}

describe("consolidateEpisodicSlice (Phase N)", () => {
  it("noops when the window is shorter than minWindowMessages", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "short conversation" },
      { role: "assistant", content: "yes indeed" },
    ];
    const result = consolidateEpisodicSlice({ messages });
    expect(result.action).toBe("noop");
    expect(result.summaryMessage).toBeUndefined();
  });

  it("noops on a long but content-less window", () => {
    const messages: LLMMessage[] = Array.from({ length: 25 }, () => ({
      role: "user" as const,
      content: "the and for with",
    }));
    const result = consolidateEpisodicSlice({ messages });
    expect(result.action).toBe("noop");
  });

  it("produces a [consolidation] summary when topics repeat", () => {
    const messages: LLMMessage[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push({
        role: "user",
        content: "please analyze the database migration plan for postgres",
      });
      messages.push({
        role: "assistant",
        content: "analysis of database migration requires postgres schema",
      });
    }
    const result = consolidateEpisodicSlice({ messages });
    expect(result.action).toBe("consolidated");
    expect(result.summaryMessage).toBeDefined();
    const content = result.summaryMessage?.content as string;
    expect(content.startsWith("[consolidation]")).toBe(true);
    // The recurring tokens (database, migration, postgres, analyze,
    // analysis, schema, plan) should show up in the summary.
    expect(content).toMatch(/database/);
    expect(content).toMatch(/migration/);
    expect(content).toMatch(/postgres/);
  });

  it("honors minWindowMessages override", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "analyzing kubernetes database migration" },
      { role: "assistant", content: "kubernetes analysis requires database migration review" },
      { role: "user", content: "kubernetes pod database migration scope" },
      { role: "assistant", content: "database migration review kubernetes pod" },
    ];
    const result = consolidateEpisodicSlice({
      messages,
      minWindowMessages: 3,
    });
    expect(result.action).toBe("consolidated");
  });

  it("filters stopwords", () => {
    const messages: LLMMessage[] = Array.from({ length: 25 }, () => ({
      role: "user" as const,
      content: "the workflow and the pipeline with the artifact",
    }));
    const result = consolidateEpisodicSlice({ messages });
    expect(result.action).toBe("consolidated");
    const content = result.summaryMessage?.content as string;
    // The template prefix contains natural stopwords, so we split on
    // the colon and only check the ranked topic list.
    const [, topicList] = content.split(":", 2);
    expect(topicList).toBeDefined();
    expect(topicList).not.toMatch(/\bthe\b/);
    expect(topicList).not.toMatch(/\band\b/);
    expect(topicList).not.toMatch(/\bwith\b/);
    // Content words should be kept.
    expect(topicList).toMatch(/workflow/);
    expect(topicList).toMatch(/pipeline/);
    expect(topicList).toMatch(/artifact/);
  });

  it("caps the summary at maxSummaryTokens", () => {
    const messages: LLMMessage[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push({
        role: "user",
        content:
          "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron",
      });
    }
    const result = consolidateEpisodicSlice({
      messages,
      maxSummaryTokens: 5,
    });
    expect(result.action).toBe("consolidated");
    expect(result.tokensKept).toBe(5);
  });

  it("is deterministic (same input -> same summary)", () => {
    const messages = msgs(25, "repeat keyword payload");
    const a = consolidateEpisodicSlice({ messages });
    const b = consolidateEpisodicSlice({ messages });
    expect(a.summaryMessage?.content).toEqual(b.summaryMessage?.content);
  });

  it("handles multimodal content parts by extracting text", () => {
    const messages: LLMMessage[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push({
        role: "assistant",
        content: [
          { type: "text", text: "kubernetes cluster setup" },
          { type: "image", data: "ignored" },
          { type: "text", text: "pod scheduling failure" },
        ] as unknown as string,
      });
    }
    const result = consolidateEpisodicSlice({ messages });
    expect(result.action).toBe("consolidated");
    const content = result.summaryMessage?.content as string;
    expect(content).toMatch(/kubernetes/);
    expect(content).toMatch(/cluster/);
    expect(content).toMatch(/scheduling/);
  });
});
