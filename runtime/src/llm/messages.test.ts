/**
 * Phase J acceptance test: `normalizeMessagesForAPI` applies
 * `cacheControl: "ephemeral"` breakpoints on the three strategic
 * messages (last system, last non-tool user, last tool result) so
 * provider adapters that support prompt caching can pin stable
 * prefixes.
 *
 * Also re-covers the existing normalization steps to prevent
 * regressions: boundary stripping, empty assistant elision,
 * consecutive-user merging, and orphan-tool filtering.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeMessagesForAPI,
  applyCacheControlBreakpoints,
} from "./messages.js";
import type { LLMMessage } from "./types.js";

type TaggedMessage = LLMMessage & { cacheControl?: "ephemeral" };

describe("normalizeMessagesForAPI", () => {
  it("strips boundary system messages (snip/microcompact/context-collapse/autocompact)", () => {
    const input: LLMMessage[] = [
      { role: "system", content: "You are a test." },
      { role: "system", content: "[snip] dropped 12 messages" },
      { role: "system", content: "[context-collapse] projected older messages" },
      { role: "user", content: "hi" },
      { role: "system", content: "[autocompact] history exceeded" },
    ];
    const out = normalizeMessagesForAPI(input);
    expect(out.map((m) => m.content)).not.toContain("[snip] dropped 12 messages");
    expect(out.map((m) => m.content)).not.toContain(
      "[context-collapse] projected older messages",
    );
    expect(out.map((m) => m.content)).not.toContain(
      "[autocompact] history exceeded",
    );
    expect(out.some((m) => m.role === "system" && m.content === "You are a test.")).toBe(
      true,
    );
  });

  it("merges consecutive user messages", () => {
    const input: LLMMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "part a" },
      { role: "user", content: "part b" },
    ];
    const out = normalizeMessagesForAPI(input);
    const userMessages = out.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.content).toBe("part a\n\npart b");
  });

  it("does not merge synthetic user-context messages into adjacent user turns", () => {
    const input: LLMMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: "<system-reminder>\n# context\nvalue\n</system-reminder>",
        runtimeOnly: { mergeBoundary: "user_context" },
      },
      { role: "user", content: "real user turn" },
    ];
    const out = normalizeMessagesForAPI(input);
    const userMessages = out.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]!.content).toContain("<system-reminder>");
    expect(userMessages[1]!.content).toBe("real user turn");
  });

  it("drops orphan tool messages", () => {
    const input: LLMMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      // orphan tool result — no matching assistant tool_calls
      {
        role: "tool",
        content: "orphan result",
        toolCallId: "no-match",
        toolName: "system.readFile",
      },
    ];
    const out = normalizeMessagesForAPI(input);
    expect(out.some((m) => m.role === "tool")).toBe(false);
  });

  it("can preserve orphan tool messages for downstream repair", () => {
    const input: LLMMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      {
        role: "tool",
        content: "orphan result",
        toolCallId: "no-match",
        toolName: "system.readFile",
      },
    ];
    const out = normalizeMessagesForAPI(input, {
      dropOrphanToolMessages: false,
    });
    expect(out.some((m) => m.role === "tool" && m.content === "orphan result")).toBe(
      true,
    );
  });

  it("keeps tool messages whose toolCallId matches a prior assistant tool_call", () => {
    const input: LLMMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "calling tool",
        toolCalls: [{ id: "c1", name: "system.readFile", arguments: "{}" }],
      },
      {
        role: "tool",
        content: "file body",
        toolCallId: "c1",
        toolName: "system.readFile",
      },
    ];
    const out = normalizeMessagesForAPI(input);
    expect(out.some((m) => m.role === "tool" && m.content === "file body")).toBe(
      true,
    );
  });
});

describe("applyCacheControlBreakpoints (Phase J)", () => {
  it("tags the last system, last user, and last tool message", () => {
    const input: LLMMessage[] = [
      { role: "system", content: "sys-old" },
      { role: "system", content: "sys-latest" },
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "calling",
        toolCalls: [{ id: "c1", name: "t", arguments: "{}" }],
      },
      { role: "tool", content: "r1", toolCallId: "c1", toolName: "t" },
    ];
    const tagged = applyCacheControlBreakpoints(input);
    const taggedBreakdown = tagged as TaggedMessage[];

    // Only one system message tagged — the latest.
    const taggedSystems = taggedBreakdown.filter(
      (m) => m.role === "system" && m.cacheControl === "ephemeral",
    );
    expect(taggedSystems).toHaveLength(1);
    expect(taggedSystems[0]!.content).toBe("sys-latest");

    // Last user tagged.
    const taggedUsers = taggedBreakdown.filter(
      (m) => m.role === "user" && m.cacheControl === "ephemeral",
    );
    expect(taggedUsers).toHaveLength(1);

    // Last tool tagged.
    const taggedTools = taggedBreakdown.filter(
      (m) => m.role === "tool" && m.cacheControl === "ephemeral",
    );
    expect(taggedTools).toHaveLength(1);
  });

  it("returns the input unchanged when empty", () => {
    expect(applyCacheControlBreakpoints([])).toEqual([]);
  });

  it("tags only what exists (no user message present)", () => {
    const input: LLMMessage[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "hi" },
    ];
    const tagged = applyCacheControlBreakpoints(input) as TaggedMessage[];
    const taggedCount = tagged.filter(
      (m) => m.cacheControl === "ephemeral",
    ).length;
    expect(taggedCount).toBe(1); // just the system message
  });

  it("does not modify the original array", () => {
    const input: LLMMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
    ];
    const tagged = applyCacheControlBreakpoints(input);
    expect(input[0]).not.toHaveProperty("cacheControl");
    expect((tagged[0] as TaggedMessage).cacheControl).toBe("ephemeral");
  });

  it("integrates with normalizeMessagesForAPI end-to-end", () => {
    const input: LLMMessage[] = [
      { role: "system", content: "[snip] dropped 10 messages" }, // stripped
      { role: "system", content: "You are the test." }, // tagged
      { role: "user", content: "q1" },
      { role: "user", content: "q2" }, // merged with q1 -> q1\n\nq2
      {
        role: "assistant",
        content: "calling",
        toolCalls: [{ id: "t1", name: "t", arguments: "{}" }],
      },
      {
        role: "tool",
        content: "result",
        toolCallId: "t1",
        toolName: "t",
      },
    ];
    const out = normalizeMessagesForAPI(input) as TaggedMessage[];
    // Snip boundary stripped.
    expect(out.some((m) => m.content === "[snip] dropped 10 messages")).toBe(
      false,
    );
    // Users merged.
    const users = out.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.content).toBe("q1\n\nq2");
    // The merged user carries the cacheControl tag.
    expect(users[0]!.cacheControl).toBe("ephemeral");
    // The surviving tool message carries the tag.
    const tools = out.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.cacheControl).toBe("ephemeral");
    // The system prompt carries the tag.
    const systems = out.filter((m) => m.role === "system");
    expect(systems).toHaveLength(1);
    expect(systems[0]!.cacheControl).toBe("ephemeral");
  });
});
