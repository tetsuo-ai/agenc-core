/**
 * Tests for the discriminated-union `ToolOutput` port (context.ts).
 *
 * Covers the 5 variants (function / mcp / exec / tool_search /
 * aborted), the variant → text flattener (`toText`), the variant →
 * LLMMessage projector (`toResponseItem`), the bounded log preview
 * helper, the image-detail sanitizer, and the exec-variant 400KB
 * truncation cap.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import {
  abortedToolOutput,
  codeModeResult,
  contentItemsToCodeModeResult,
  contentItemsToText,
  DEFAULT_IMAGE_DETAIL,
  DEFAULT_MAX_EXEC_OUTPUT_BYTES,
  execToolOutput,
  functionToolOutput,
  functionToolOutputFromContent,
  functionToolOutputFromText,
  intoText,
  logPreview,
  mcpToolOutput,
  parseToolName,
  sanitizeOriginalImageDetail,
  successForLogging,
  boundedLogPreview,
  boundedLogPreviewWith,
  LOG_PREVIEW_MAX_BYTES,
  LOG_PREVIEW_MAX_LINES,
  LOG_PREVIEW_TRUNCATION_NOTICE,
  responseInputToCodeModeResult,
  toolSearchToolOutput,
  toResponseItem,
  toText,
  type MCPContentItem,
  type ToolPayload,
} from "./context.js";

const toolName = parseToolName("agenc.echo");
const payload: ToolPayload = { kind: "function", arguments: "{}" };

describe("ToolOutput variants", () => {
  test("function variant: from_text preserves text and flattens via toText", () => {
    const out = functionToolOutputFromText({
      callId: "c1",
      toolName,
      payload,
      text: "hello",
      isError: false,
      durationMs: 1,
    });
    expect(out.variant?.kind).toBe("function");
    expect(out.content).toBe("hello");
    expect(toText(out)).toBe("hello");
    expect(intoText(out)).toBe("hello");
    expect(successForLogging(out)).toBe(true);
  });

  test("function variant: from_content joins text + image parts", () => {
    const out = functionToolOutputFromContent({
      callId: "c1",
      toolName,
      payload,
      body: [
        { type: "input_text", text: "alpha" },
        { type: "input_image", image_url: "https://img/x.png" },
        { type: "input_text", text: "-beta" },
      ],
      isError: false,
      durationMs: 2,
    });
    expect(out.variant?.kind).toBe("function");
    expect(toText(out)).toBe("alphahttps://img/x.png-beta");
  });

  test("function variant: legacy functionToolOutput still works and exposes .content", () => {
    const out = functionToolOutput({
      callId: "c1",
      toolName,
      payload,
      content: "legacy",
      isError: false,
      durationMs: 3,
    });
    expect(out.content).toBe("legacy");
    expect(out.variant?.kind).toBe("function");
  });

  test("mcp variant: preserves structured content and emits trailing wall-time footer", () => {
    const structured = {
      content: [
        { type: "text" as const, text: "hi there" } satisfies MCPContentItem,
      ],
      structuredContent: { ok: true },
    };
    const out = mcpToolOutput({
      callId: "c1",
      toolName,
      payload,
      structured,
      wallTimeMs: 250,
      durationMs: 250,
    });
    expect(out.variant?.kind).toBe("mcp");
    const text = toText(out);
    // Output leads, footer trails. The model must see the actual content
    // before any timing metadata or it triggers retry loops.
    expect(text.startsWith("hi there")).toBe(true);
    expect(text).toContain("[mcp wall_time=0.2500s]");
  });

  test("exec variant: output leads, footer trails with exit/wall/chunk metadata", () => {
    const out = execToolOutput({
      callId: "c1",
      toolName,
      payload,
      rawOutput: Buffer.from("stdout body", "utf8"),
      exitCode: 0,
      wallTimeMs: 125,
      chunkId: "chunk-abc",
      durationMs: 125,
    });
    expect(out.variant?.kind).toBe("exec");
    const text = toText(out);
    expect(text.startsWith("stdout body")).toBe(true);
    expect(text).toContain("exit_code=0");
    expect(text).toContain("wall_time=0.1250s");
    expect(text).toContain("chunk_id=chunk-abc");
    // The footer must be on its own line, after a blank separator, and
    // wrapped in the [exec ...] marker.
    expect(text).toMatch(/\n\n\[exec [^\]]+\]$/);
  });

  test("exec variant: 400KB truncation applied with marker", () => {
    const big = Buffer.alloc(DEFAULT_MAX_EXEC_OUTPUT_BYTES + 10_000, 0x41);
    const out = execToolOutput({
      callId: "c1",
      toolName,
      payload,
      rawOutput: big,
      wallTimeMs: 0,
      durationMs: 0,
    });
    const text = toText(out);
    expect(text).toContain(`[truncated: original was ${big.length} bytes`);
    // Bounded by the cap + header overhead.
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(
      DEFAULT_MAX_EXEC_OUTPUT_BYTES + 1024,
    );
  });

  test("exec variant: honors per-call maxOutputBytes override", () => {
    const out = execToolOutput({
      callId: "c1",
      toolName,
      payload,
      rawOutput: Buffer.from("x".repeat(5000), "utf8"),
      wallTimeMs: 0,
      maxOutputBytes: 500,
      durationMs: 0,
    });
    expect(toText(out)).toContain(
      "[truncated: original was 5000 bytes, returning first 500]",
    );
  });

  test("tool_search variant: exposes tools array and serializes to JSON", () => {
    const tools = [
      { name: "read", description: "read a file" },
      { name: "write", description: "write a file" },
    ];
    const out = toolSearchToolOutput({
      callId: "c1",
      toolName,
      payload: { kind: "tool_search", arguments: { query: "file" } },
      tools,
      durationMs: 10,
    });
    expect(out.variant?.kind).toBe("tool_search");
    expect(toText(out)).toBe(JSON.stringify(tools));
  });

  test("aborted variant: shell tools get output-first cancellation with footer", () => {
    const shellName = parseToolName("system.bash");
    const out = abortedToolOutput(shellName, payload, 500);
    // Note: signature is (callId, toolName, payload, elapsedMs)
    void out;
    const real = abortedToolOutput("c1", shellName, payload, 500);
    expect(real.variant?.kind).toBe("aborted");
    const text = toText(real);
    expect(text.startsWith("aborted by user")).toBe(true);
    expect(text).toContain("[exec wall_time=0.5s aborted=true]");
    expect(successForLogging(real)).toBe(false);
  });

  test("aborted variant: non-shell tools get simple aborted message", () => {
    const name = parseToolName("agenc.echo");
    const out = abortedToolOutput("c1", name, payload, 1200);
    expect(toText(out)).toBe("aborted by user after 1.2s");
  });
});

describe("toResponseItem projection", () => {
  test("function variant → {role:'tool', content}", () => {
    const out = functionToolOutputFromText({
      callId: "c1",
      toolName,
      payload,
      text: "hi",
      isError: false,
      durationMs: 0,
    });
    const msg = toResponseItem(out);
    expect(msg.role).toBe("tool");
    expect(msg.toolCallId).toBe("c1");
    expect(msg.content).toBe("hi");
  });

  test("mcp variant → structured payload with mcp_tool_call_output", () => {
    const out = mcpToolOutput({
      callId: "c1",
      toolName,
      payload,
      structured: {
        content: [{ type: "text", text: "ok" }],
      },
      wallTimeMs: 100,
      durationMs: 100,
    });
    const msg = toResponseItem(out);
    expect(msg.structured).toBeDefined();
    expect((msg.structured as { type: string }).type).toBe(
      "mcp_tool_call_output",
    );
  });

  test("tool_search variant → structured payload with tool_search_output + tools array", () => {
    const tools = [{ name: "read" }];
    const out = toolSearchToolOutput({
      callId: "c1",
      toolName,
      payload: { kind: "tool_search", arguments: { query: "read" } },
      tools,
      durationMs: 0,
    });
    const msg = toResponseItem(out);
    const s = msg.structured as { type: string; tools: unknown[] };
    expect(s.type).toBe("tool_search_output");
    expect(s.tools).toHaveLength(1);
  });

  test("aborted variant dispatches on payload: tool_search → empty tools", () => {
    const searchPayload: ToolPayload = {
      kind: "tool_search",
      arguments: { query: "x" },
    };
    const out = abortedToolOutput("c1", toolName, searchPayload, 0);
    const msg = toResponseItem(out);
    const s = msg.structured as { type: string; tools: unknown[] };
    expect(s.type).toBe("tool_search_output");
    expect(s.tools).toHaveLength(0);
  });

  test("aborted variant dispatches on payload: mcp → MCP error envelope", () => {
    const mcpPayload: ToolPayload = {
      kind: "mcp",
      server: "srv",
      tool: "t",
      rawArguments: "{}",
    };
    const out = abortedToolOutput("c1", toolName, mcpPayload, 0);
    const msg = toResponseItem(out);
    const s = msg.structured as { type: string; result: { isError: boolean } };
    expect(s.type).toBe("mcp_tool_call_output");
    expect(s.result.isError).toBe(true);
  });

});

describe("boundedLogPreview", () => {
  test("short input returns unchanged", () => {
    expect(boundedLogPreview("hello")).toBe("hello");
    expect(boundedLogPreview("")).toBe("");
  });

  test("byte-boundary truncation appends notice", () => {
    const big = "x".repeat(LOG_PREVIEW_MAX_BYTES + 8);
    const preview = boundedLogPreview(big);
    expect(preview.endsWith(LOG_PREVIEW_TRUNCATION_NOTICE)).toBe(true);
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(
      LOG_PREVIEW_MAX_BYTES +
        LOG_PREVIEW_TRUNCATION_NOTICE.length +
        1,
    );
  });

  test("line-limit truncation appends notice and respects line cap", () => {
    const many = Array.from(
      { length: LOG_PREVIEW_MAX_LINES + 5 },
      (_unused, i) => `line-${i}`,
    ).join("\n");
    const preview = boundedLogPreview(many);
    expect(preview.endsWith(LOG_PREVIEW_TRUNCATION_NOTICE)).toBe(true);
    const lines = preview.split("\n");
    // At most maxLines + 1 (the notice line).
    expect(lines.length).toBeLessThanOrEqual(LOG_PREVIEW_MAX_LINES + 1);
  });

  test("parameterized variant respects both byte and line caps", () => {
    const short = "a\nb\nc\nd\ne";
    const preview = boundedLogPreviewWith(short, 100, 2);
    expect(preview).toContain(LOG_PREVIEW_TRUNCATION_NOTICE);
    expect(preview.startsWith("a\nb")).toBe(true);
  });

  test("logPreview flows through boundedLogPreview", () => {
    const out = functionToolOutputFromText({
      callId: "c1",
      toolName,
      payload,
      text: "x".repeat(LOG_PREVIEW_MAX_BYTES + 8),
      isError: false,
      durationMs: 0,
    });
    const p = logPreview(out);
    expect(p.endsWith(LOG_PREVIEW_TRUNCATION_NOTICE)).toBe(true);
  });
});

describe("sanitizeOriginalImageDetail", () => {
  test("returns unchanged copy when model supports original detail", () => {
    const items: ReadonlyArray<MCPContentItem> = [
      {
        type: "image",
        data: "abc",
        mimeType: "image/png",
        original_image_detail: "original",
      },
    ];
    const out = sanitizeOriginalImageDetail(true, items);
    expect(out).not.toBe(items);
    expect((out[0] as { original_image_detail?: string }).original_image_detail).toBe(
      "original",
    );
    // Input is not mutated.
    expect(
      (items[0] as { original_image_detail?: string }).original_image_detail,
    ).toBe("original");
  });

  test("rewrites original → default when unsupported", () => {
    const items: ReadonlyArray<MCPContentItem> = [
      {
        type: "image",
        data: "abc",
        mimeType: "image/png",
        original_image_detail: "original",
      },
    ];
    const out = sanitizeOriginalImageDetail(false, items);
    expect(
      (out[0] as { original_image_detail?: string }).original_image_detail,
    ).toBe(DEFAULT_IMAGE_DETAIL);
    // Input preserved.
    expect(
      (items[0] as { original_image_detail?: string }).original_image_detail,
    ).toBe("original");
  });

  test("leaves non-image items untouched", () => {
    const items: ReadonlyArray<MCPContentItem> = [
      { type: "text", text: "hello" },
    ];
    const out = sanitizeOriginalImageDetail(false, items);
    expect(out[0]).toEqual({ type: "text", text: "hello" });
  });
});

describe("contentItemsToText", () => {
  test("joins text and image_url parts", () => {
    expect(
      contentItemsToText([
        { type: "input_text", text: "a" },
        { type: "input_image", image_url: "x" },
        { type: "input_text", text: "b" },
      ]),
    ).toBe("axb");
  });
});

describe("codeModeResult", () => {
  test("function text result returns the plain content", () => {
    const out = functionToolOutputFromText({
      callId: "c1",
      toolName,
      payload,
      text: "hi",
      isError: false,
      durationMs: 0,
    });
    expect(codeModeResult(out)).toBe("hi");
  });

  test("function content items join non-empty text and image URLs with newlines", () => {
    const out = functionToolOutputFromContent({
      callId: "c1",
      toolName,
      payload,
      body: [
        { type: "input_text", text: "  " },
        { type: "input_text", text: "line 1" },
        { type: "input_image", image_url: "https://img/x.png" },
        { type: "input_text", text: "line 2" },
        { type: "input_image", image_url: "" },
      ],
      isError: false,
      durationMs: 0,
    });

    expect(codeModeResult(out)).toBe("line 1\nhttps://img/x.png\nline 2");
    expect(
      contentItemsToCodeModeResult([
        { type: "input_text", text: "a" },
        { type: "input_image", image_url: "x" },
        { type: "input_text", text: "b" },
      ]),
    ).toBe("a\nx\nb");
  });

  test("mcp result stays as the raw call-tool result", () => {
    const out = mcpToolOutput({
      callId: "c1",
      toolName,
      payload: {
        kind: "mcp",
        server: "server",
        tool: "tool",
        rawArguments: "{}",
      },
      structured: {
        content: [{ type: "text", text: "ignored" }],
        structuredContent: { content: "done" },
        isError: false,
        _meta: { source: "mcp" },
      },
      wallTimeMs: 1250,
      durationMs: 1250,
    });

    expect(codeModeResult(out)).toEqual({
      content: [{ type: "text", text: "ignored" }],
      structuredContent: { content: "done" },
      isError: false,
      _meta: { source: "mcp" },
    });
  });

  test("exec result returns the upstream unified exec object", () => {
    const out = execToolOutput({
      callId: "c1",
      toolName,
      payload,
      rawOutput: Buffer.from("stdout body", "utf8"),
      exitCode: 0,
      wallTimeMs: 1250,
      chunkId: "chunk-abc",
      processId: 42,
      originalTokenCount: 9,
      durationMs: 1250,
    });

    expect(codeModeResult(out)).toEqual({
      chunk_id: "chunk-abc",
      wall_time_seconds: 1.25,
      exit_code: 0,
      session_id: 42,
      original_token_count: 9,
      output: "stdout body",
    });
  });

  test("tool_search result returns the tools array", () => {
    const tools = [{ name: "read" }, { name: "write" }];
    const out = toolSearchToolOutput({
      callId: "c1",
      toolName,
      payload: { kind: "tool_search", arguments: { query: "file" } },
      tools,
      durationMs: 0,
    });

    expect(codeModeResult(out)).toEqual(tools);
  });

  test("aborted result dispatches by payload shape", () => {
    const searchOut = abortedToolOutput(
      "c1",
      toolName,
      { kind: "tool_search", arguments: { query: "x" } },
      0,
    );
    const mcpOut = abortedToolOutput(
      "c2",
      toolName,
      {
        kind: "mcp",
        server: "server",
        tool: "tool",
        rawArguments: "{}",
      },
      0,
    );

    expect(codeModeResult(searchOut)).toEqual([]);
    expect(codeModeResult(mcpOut)).toEqual({
      content: [{ type: "text", text: "aborted by user after 0.0s" }],
      isError: true,
    });
  });

  test("responseInputToCodeModeResult handles structured response items", () => {
    const tools = [{ name: "read" }];
    const searchOut = toolSearchToolOutput({
      callId: "c1",
      toolName,
      payload: { kind: "tool_search", arguments: { query: "read" } },
      tools,
      durationMs: 0,
    });

    expect(responseInputToCodeModeResult(toResponseItem(searchOut))).toEqual(
      tools,
    );
  });
});
