import { describe, expect, it } from "vitest";

import {
  buildToolExecutionGroundingMessage,
  generateFallbackContent,
  normalizeHistory,
  prepareToolResultForPrompt,
  summarizeToolCalls,
} from "./chat-executor-text.js";

describe("chat-executor-text", () => {
  it("builds an authoritative runtime tool ledger with tool calls and provider citations", () => {
    const message = buildToolExecutionGroundingMessage({
      toolCalls: [
        {
          name: "desktop.bash",
          args: { command: "mkdir -p /workspace/pong" },
          result: JSON.stringify({
            stdout: "",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 11,
        },
        {
          name: "execute_with_agent",
          args: { objective: "Research mechanics" },
          result: JSON.stringify({
            success: false,
            error: "Delegated task required browser-grounded evidence",
          }),
          isError: true,
          durationMs: 37,
        },
      ],
      providerEvidence: {
        citations: ["https://docs.x.ai/developers/tools/web-search"],
      },
    });

    expect(message).toBeDefined();
    expect(message?.role).toBe("system");
    expect(String(message?.content)).toContain("Runtime execution ledger");
    expect(String(message?.content)).toContain('"tool":"desktop.bash"');
    expect(String(message?.content)).toContain('"tool":"execute_with_agent"');
    expect(String(message?.content)).toContain('"providerCitations"');
    expect(String(message?.content)).toContain(
      "https://docs.x.ai/developers/tools/web-search",
    );
  });

  it("surfaces provider-native server-side tool telemetry even without citations", () => {
    const message = buildToolExecutionGroundingMessage({
      toolCalls: [],
      providerEvidence: {
        serverSideToolCalls: [
          {
            type: "web_search_call",
            toolType: "web_search",
            id: "ws_123",
            status: "completed",
          },
        ],
        serverSideToolUsage: [
          {
            category: "SERVER_SIDE_TOOL_WEB_SEARCH",
            toolType: "web_search",
            count: 1,
          },
        ],
      },
    });

    expect(message).toBeDefined();
    expect(String(message?.content)).toContain('"providerServerSideToolCallCount":1');
    expect(String(message?.content)).toContain('"type":"web_search_call"');
    expect(String(message?.content)).toContain('"category":"SERVER_SIDE_TOOL_WEB_SEARCH"');
  });

  it("keeps oversized runtime tool ledgers bounded and marks them truncated", () => {
    const message = buildToolExecutionGroundingMessage({
      toolCalls: Array.from({ length: 30 }, (_, index) => ({
        name: index === 0 ? "execute_with_agent" : "desktop.bash",
        args: {
          command: `echo ${"x".repeat(400)}`,
          index,
        },
        result: JSON.stringify({
          stdout: "y".repeat(4_000),
          stderr: index === 0 ? "delegated child failed" : "",
          exitCode: index === 0 ? 1 : 0,
        }),
        isError: index === 0,
        durationMs: 10 + index,
      })),
    });

    expect(message).toBeDefined();
    expect(String(message?.content).length).toBeLessThanOrEqual(100_000);
    expect(String(message?.content)).toContain('"failedToolNames":["execute_with_agent"]');
  });

  it("uses successful delegated child output in fallback summaries", () => {
    const content = summarizeToolCalls([
      {
        name: "execute_with_agent",
        args: {
          task: "Recall the token",
        },
        result: JSON.stringify({
          status: "completed",
          success: true,
          output: "TOKEN=IVORY-CIRCUIT-92",
          subagentSessionId: "subagent:memory",
          toolCalls: [],
        }),
        isError: false,
        durationMs: 12,
      },
    ]);

    expect(content).toBe("TOKEN=IVORY-CIRCUIT-92");
  });

  it("does not replay delegated cwd claims as authoritative fallback summaries", () => {
    const content = summarizeToolCalls([
      {
        name: "execute_with_agent",
        args: {
          task: "What is the current working directory in the child agent?",
        },
        result: JSON.stringify({
          status: "completed",
          success: true,
          output: "Subagent cwd: /",
          subagentSessionId: "subagent:cwd",
          toolCalls: [],
        }),
        isError: false,
        durationMs: 12,
      },
    ]);

    expect(content).toBe("Completed execute_with_agent");
  });

  it("propagates delegated child output from generateFallbackContent", () => {
    const content = generateFallbackContent([
      {
        name: "execute_with_agent",
        args: {
          task: "Recall the token",
        },
        result: JSON.stringify({
          status: "completed",
          success: true,
          output: "TOKEN=IVORY-CIRCUIT-92",
          subagentSessionId: "subagent:memory",
          toolCalls: [],
        }),
        isError: false,
        durationMs: 12,
      },
    ]);

    expect(content).toBe("TOKEN=IVORY-CIRCUIT-92");
  });

  it("suppresses delegated cwd echoes from the authoritative runtime tool ledger preview", () => {
    const message = buildToolExecutionGroundingMessage({
      toolCalls: [
        {
          name: "execute_with_agent",
          args: {
            task: "Run pwd in the child agent and report it.",
          },
          result: JSON.stringify({
            status: "completed",
            success: true,
            output: "Subagent cwd: /",
            subagentSessionId: "subagent:cwd",
            toolCalls: [],
          }),
          isError: false,
          durationMs: 17,
        },
      ],
    });

    expect(String(message?.content)).toContain(
      "[delegated output suppressed: untrusted cwd/workspace-root claim]",
    );
    expect(String(message?.content)).not.toContain("Subagent cwd: /");
  });

  it("rewrites rejected delegated scope failures before replaying them to the model", () => {
    const prepared = prepareToolResultForPrompt(
      JSON.stringify({
        success: false,
        error:
          'Requested delegated workspace root "/" is outside the trusted parent workspace root "/tmp/project".',
        issues: [{ code: "workspace_root_outside_parent_workspace" }],
        delegatedScopeTrust: "rejected_invalid_scope",
      }),
    );

    expect(prepared.text).toContain("Delegated scope was rejected by the runtime");
    expect(prepared.text).not.toContain('workspace root "/"');
    expect(prepared.text).not.toContain('"issues"');
  });

  it("omits assistant delegated cwd summaries from replay history", () => {
    const normalized = normalizeHistory([
      {
        role: "assistant",
        content: "Subagent cwd: /",
      },
    ]);

    expect(String(normalized[0]?.content)).toContain(
      "[assistant summary omitted: delegated cwd/workspace-root claim not replayed]",
    );
    expect(String(normalized[0]?.content)).not.toContain("Subagent cwd: /");
  });

});
