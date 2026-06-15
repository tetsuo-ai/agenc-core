import { describe, expect, it } from "vitest";
import type { LLMMessage, LLMTool } from "../../types.js";
import {
  buildProviderTraceErrorPayload,
  cloneProviderTracePayload,
  computeReconciliationChain,
  extractTraceToolNames,
  slimTools,
  toSlimTool,
} from "./adapter-utils.js";

describe("grok adapter utils", () => {
  it("redacts provider trace secrets recursively without changing public fields", () => {
    const payload = cloneProviderTracePayload({
      model: "grok-4-fast",
      tools: [
        {
          type: "mcp",
          server_url: "https://mcp.example.test/sse",
          server_label: "docs",
          authorization: "Bearer remote-mcp-token",
          headers: {
            "x-api-key": "remote-header-key",
            "x-public-trace-id": "trace-123",
            nested: {
              refresh_token: "refresh-secret",
            },
          },
        },
      ],
      metadata: {
        cookie: "session=secret",
        safe: "visible",
      },
    });

    expect(payload).toEqual({
      model: "grok-4-fast",
      tools: [
        {
          type: "mcp",
          server_url: "https://mcp.example.test/sse",
          server_label: "docs",
          authorization: "[REDACTED]",
          headers: {
            "x-api-key": "[REDACTED]",
            "x-public-trace-id": "trace-123",
            nested: {
              refresh_token: "[REDACTED]",
            },
          },
        },
      ],
      metadata: {
        cookie: "[REDACTED]",
        safe: "visible",
      },
    });
  });

  it("redacts provider error headers from iterable header collections", () => {
    const error = new Error("upstream failed") as Error & {
      headers: Headers;
    };
    error.headers = new Headers({
      authorization: "Bearer provider-token",
      "set-cookie": "sid=secret",
      "x-request-id": "req-1",
    });

    expect(buildProviderTraceErrorPayload(error)).toMatchObject({
      name: "Error",
      message: "upstream failed",
      headers: {
        authorization: "[REDACTED]",
        "set-cookie": "[REDACTED]",
        "x-request-id": "req-1",
      },
    });
  });

  it("extracts trace tool names from mixed provider tool shapes", () => {
    expect(
      extractTraceToolNames([
        { type: "web_search" },
        { name: "system.bash" },
        {
          type: "function",
          function: {
            name: "desktop.screenshot",
          },
        },
      ]),
    ).toEqual([
      "web_search",
      "system.bash",
      "desktop.screenshot",
    ]);
  });

  it("keeps reconciliation hashes stable across tool-call order changes", () => {
    const first: LLMMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "b", name: "system.bash", arguments: "{\"command\":\"pwd\"}" },
          { id: "a", name: "system.bash", arguments: "{\"command\":\"ls\"}" },
        ],
      },
    ];
    const second: LLMMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "system.bash", arguments: "{\"command\":\"ls\"}" },
          { id: "b", name: "system.bash", arguments: "{\"command\":\"pwd\"}" },
        ],
      },
    ];

    expect(computeReconciliationChain(first, 8)).toEqual(
      computeReconciliationChain(second, 8),
    );
  });

  it("orders AgenC-primary AgenC tools before compatibility system tools", () => {
    const makeTool = (name: string): LLMTool => ({
      type: "function",
      function: {
        name,
        description: name,
        parameters: { type: "object" },
      },
    });

    const { tools } = slimTools([
      makeTool("FileRead"),
      makeTool("system.bash"),
      makeTool("exec_command"),
      makeTool("write_stdin"),
      makeTool("system.searchTools"),
    ]);

    expect(tools.map((tool) => tool.function.name)).toEqual([
      "exec_command",
      "FileRead",
      "system.searchTools",
      "write_stdin",
      "system.bash",
    ]);
  });

  it("ignores dynamic system injections when hashing reconciliation state", () => {
    const first: LLMMessage[] = [
      { role: "system", content: "base prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const second: LLMMessage[] = [
      { role: "system", content: "base prompt updated" },
      { role: "system", content: "<memory>fresh working summary</memory>" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    expect(computeReconciliationChain(first, 8)).toEqual(
      computeReconciliationChain(second, 8),
    );
  });

  it("ignores assistant commentary phase when hashing reconciliation state", () => {
    const first: LLMMessage[] = [
      { role: "user", content: "finish the delegated phase" },
      { role: "assistant", content: "**BLOCKED**: missing grounded evidence" },
    ];
    const second: LLMMessage[] = [
      { role: "user", content: "finish the delegated phase" },
      {
        role: "assistant",
        content: "**BLOCKED**: missing grounded evidence",
        phase: "commentary",
      },
      { role: "system", content: "Retry with tool-grounded evidence." },
    ];

    expect(computeReconciliationChain(first, 8).anchorHash).toBe(
      computeReconciliationChain(second, 8).anchorHash,
    );
  });

  it("keeps recent anchors matchable after the reconciliation window shifts", () => {
    const first: LLMMessage[] = Array.from({ length: 50 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn-${index}`,
    }));
    const second: LLMMessage[] = [
      ...first,
      { role: "assistant", content: "turn-50" },
      { role: "user", content: "turn-51" },
    ];

    const firstChain = computeReconciliationChain(first, 48);
    const secondChain = computeReconciliationChain(second, 48);

    expect(secondChain.chain).toContain(firstChain.anchorHash);
    expect(firstChain.messageCountUsed).toBe(50);
    expect(secondChain.messageCountUsed).toBe(52);
    expect(firstChain.source).toBe("non_system_messages");
  });

  it("passes long descriptions and large schemas through intact and strips nested metadata", () => {
    // Previously the runtime truncated descriptions at 200 chars and
    // collapsed schemas over 3000 chars into a generic open object.
    // Both caps were removed because they silently defeated
    // model-contract prompts (TodoWrite "Task Completion Requirements"
    // etc.). This test asserts the current pass-through behavior plus
    // the still-needed sanitizeSchema metadata strip.
    const hugeProperties = Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [
        `field_${index}`,
        { type: "string", description: "x".repeat(32) },
      ]),
    );
    const longDescription = "y".repeat(4000);
    const tool: LLMTool = {
      type: "function",
      function: {
        name: "system.bash",
        description: longDescription,
        parameters: {
          type: "object",
          properties: hugeProperties,
          required: ["field_0"],
        },
      },
    };

    const slim = toSlimTool(tool).tool;

    // Full description preserved.
    expect(slim.function.description).toBe(longDescription);
    // Schema preserved (not collapsed to a generic open object).
    const params = slim.function.parameters as Record<string, unknown>;
    expect(params.type).toBe("object");
    expect((params as { properties?: Record<string, unknown> }).properties)
      .toBeDefined();
    const props = params.properties as Record<string, unknown>;
    expect(Object.keys(props).length).toBe(400);
    // Nested-field descriptions stripped (Grok-schema sanitization).
    const firstField = props.field_0 as Record<string, unknown>;
    expect(firstField.type).toBe("string");
    expect(firstField.description).toBeUndefined();
    // required array preserved.
    expect(params.required).toEqual(["field_0"]);
  });
});
