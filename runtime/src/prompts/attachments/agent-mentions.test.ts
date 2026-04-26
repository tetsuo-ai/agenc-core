/**
 * Tests for the agent-mentions attachment producer.
 */
import { describe, expect, test } from "vitest";

import {
  agentMentionsProducer,
  extractAgentMentions,
} from "./agent-mentions.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";

function makeOpts(userInput: string | null): GetAttachmentsOptions {
  return {
    sessionKey: {},
    userInput,
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: "/tmp/agenc-agent-mentions-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
  };
}

describe("agentMentionsProducer", () => {
  test("returns [] for plain text without mentions", async () => {
    const out = await agentMentionsProducer(makeOpts("do X please"), {} as never);
    expect(out).toEqual([]);
  });

  test("returns [] for null userInput", async () => {
    const out = await agentMentionsProducer(makeOpts(null), {} as never);
    expect(out).toEqual([]);
  });

  test("emits one agent_mention for an @agent-<type> form", async () => {
    const out = await agentMentionsProducer(
      makeOpts("ask @agent-explore to find Y"),
      {} as never,
    );
    expect(out).toEqual([{ kind: "agent_mention", agentType: "explore" }]);
  });

  test("emits one agent_mention for an autocomplete-quoted form", async () => {
    const out = await agentMentionsProducer(
      makeOpts(`use @"code-reviewer (agent)" on this`),
      {} as never,
    );
    expect(out).toEqual([
      { kind: "agent_mention", agentType: "code-reviewer" },
    ]);
  });

  test("multiple mentions emit multiple attachments", async () => {
    const out = await agentMentionsProducer(
      makeOpts("first @agent-alpha then @agent-beta and @agent-gamma"),
      {} as never,
    );
    expect(out).toEqual([
      { kind: "agent_mention", agentType: "alpha" },
      { kind: "agent_mention", agentType: "beta" },
      { kind: "agent_mention", agentType: "gamma" },
    ]);
  });

  test("duplicate mentions are deduped", async () => {
    const out = await agentMentionsProducer(
      makeOpts("hi @agent-explore and again @agent-explore"),
      {} as never,
    );
    expect(out).toEqual([{ kind: "agent_mention", agentType: "explore" }]);
  });

  test("supports plugin-scoped types like asana:project-status-updater", async () => {
    const types = extractAgentMentions(
      "ping @agent-asana:project-status-updater now",
    );
    expect(types).toEqual(["asana:project-status-updater"]);
  });

  test("only triggers on token-boundary @ — email-style is ignored", async () => {
    // openclaude regex requires (^|\s) before @, so foo@agent-bar is
    // intentionally skipped.
    const out = await agentMentionsProducer(
      makeOpts("foo@agent-bar"),
      {} as never,
    );
    expect(out).toEqual([]);
  });
});
