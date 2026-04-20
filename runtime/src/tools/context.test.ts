/**
 * Tests for the discriminated-union `ToolOutput` port (context.ts).
 *
 * Covers the 6 variants (function / mcp / exec / apply_patch /
 * tool_search / aborted), the variant → text flattener (`toText`),
 * the variant → LLMMessage projector (`toResponseItem`), the
 * telemetry preview helper, the image-detail sanitizer, and the
 * exec-variant 400KB truncation cap.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import {
  abortedToolOutput,
  applyPatchToolOutput,
  codeModeResult,
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
  telemetryPreview,
  telemetryPreviewWith,
  TELEMETRY_PREVIEW_MAX_BYTES,
  TELEMETRY_PREVIEW_MAX_LINES,
  TELEMETRY_PREVIEW_TRUNCATION_NOTICE,
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

  test("mcp variant: preserves structured content and emits wall-time header", () => {
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
    expect(toText(out)).toContain("Wall time: 0.2500 seconds\nOutput:");
    expect(toText(out)).toContain("hi there");
  });

  test("exec variant: composes chunk/exit/process sections", () => {
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
    expect(text).toContain("Chunk ID: chunk-abc");
    expect(text).toContain("Wall time: 0.1250 seconds");
    expect(text).toContain("Process exited with code 0");
    expect(text).toContain("Output:");
    expect(text).toContain("stdout body");
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

  test("apply_patch variant: preserves diff verbatim", () => {
    const diff = "--- a/foo.ts\n+++ b/foo.ts\n@@\n-old\n+new\n";
    const out = applyPatchToolOutput({
      callId: "c1",
      toolName,
      payload,
      diff,
      durationMs: 5,
    });
    expect(out.variant?.kind).toBe("apply_patch");
    expect(toText(out)).toBe(diff);
    expect(successForLogging(out)).toBe(true);
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

  test("aborted variant: shell tools get Wall-time-prefixed message", () => {
    const shellName = parseToolName("system.bash");
    const out = abortedToolOutput(shellName, payload, 500);
    // Note: signature is (callId, toolName, payload, elapsedMs)
    void out;
    const real = abortedToolOutput("c1", shellName, payload, 500);
    expect(real.variant?.kind).toBe("aborted");
    expect(toText(real)).toContain("Wall time: 0.5 seconds");
    expect(toText(real)).toContain("aborted by user");
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

  test("apply_patch variant → content is the diff", () => {
    const diff = "--- a\n+++ b\n@@\n-old\n+new\n";
    const out = applyPatchToolOutput({
      callId: "c1",
      toolName,
      payload,
      diff,
      durationMs: 0,
    });
    expect(toResponseItem(out).content).toBe(diff);
  });
});

describe("telemetryPreview", () => {
  test("short input returns unchanged", () => {
    expect(telemetryPreview("hello")).toBe("hello");
    expect(telemetryPreview("")).toBe("");
  });

  test("byte-boundary truncation appends notice", () => {
    const big = "x".repeat(TELEMETRY_PREVIEW_MAX_BYTES + 8);
    const preview = telemetryPreview(big);
    expect(preview.endsWith(TELEMETRY_PREVIEW_TRUNCATION_NOTICE)).toBe(true);
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(
      TELEMETRY_PREVIEW_MAX_BYTES +
        TELEMETRY_PREVIEW_TRUNCATION_NOTICE.length +
        1,
    );
  });

  test("line-limit truncation appends notice and respects line cap", () => {
    const many = Array.from(
      { length: TELEMETRY_PREVIEW_MAX_LINES + 5 },
      (_unused, i) => `line-${i}`,
    ).join("\n");
    const preview = telemetryPreview(many);
    expect(preview.endsWith(TELEMETRY_PREVIEW_TRUNCATION_NOTICE)).toBe(true);
    const lines = preview.split("\n");
    // At most maxLines + 1 (the notice line).
    expect(lines.length).toBeLessThanOrEqual(TELEMETRY_PREVIEW_MAX_LINES + 1);
  });

  test("parameterized variant respects both byte and line caps", () => {
    const short = "a\nb\nc\nd\ne";
    const preview = telemetryPreviewWith(short, 100, 2);
    expect(preview).toContain(TELEMETRY_PREVIEW_TRUNCATION_NOTICE);
    expect(preview.startsWith("a\nb")).toBe(true);
  });

  test("logPreview flows through telemetryPreview", () => {
    const out = functionToolOutputFromText({
      callId: "c1",
      toolName,
      payload,
      text: "x".repeat(TELEMETRY_PREVIEW_MAX_BYTES + 8),
      isError: false,
      durationMs: 0,
    });
    const p = logPreview(out);
    expect(p.endsWith(TELEMETRY_PREVIEW_TRUNCATION_NOTICE)).toBe(true);
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

describe("codeModeResult stub", () => {
  test("returns plain text body (TODO until code_mode subsystem lands)", () => {
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
});
