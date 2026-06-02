import { describe, expect, test } from "vitest";

import {
  formatStructuredToolResult,
  makeToolResultMessage,
} from "./session-transcript.js";

// ihunt regression: the 64KB tool-result clamp must NOT sever the closing tag
// of an extracted envelope (`<bash-stdout>…</bash-stdout>`,
// `<edit-diff>…</edit-diff>`, `<read-content>…`, `<grep-matches>…`).
//
// formatStructuredToolResult wraps the ENTIRE stdout/diff/content/matches in a
// SINGLE block. The previous clampResultText head-clamped that block and kept
// only the first 64KB, dropping the `</…>` closing tag. The tool renderers then
// extract the body via the equivalent of `extractToolTag`, which returns null
// when the closing tag is missing, collapsing >64KB output to a misleading
// empty state ("(No output)" / "(empty file)" / "(No changes)" / "No matches").
//
// These tests drive the real wrap + clamp path
// (formatStructuredToolResult -> makeToolResultMessage -> clampResultContent)
// and assert the closing tag survives and the body is still extractable.

const MAX_TOOL_RESULT_BYTES = 64 * 1024;

// Mirror of the renderers' extractToolTag (tool-rendering.tsx): it needs BOTH
// the open and close tag present and returns null otherwise. This is the exact
// gate that collapsed to an empty state before the fix.
function extractToolTag(content: string, tagName: string): string | null {
  const open = `<${tagName}>`;
  const close = `</${tagName}>`;
  const startIdx = content.indexOf(open);
  if (startIdx === -1) return null;
  const valueStart = startIdx + open.length;
  const closeIdx = content.indexOf(close, valueStart);
  if (closeIdx === -1) return null;
  return content.slice(valueStart, closeIdx);
}

function storedString(message: any): string {
  const content = message.message.content[0].content;
  return typeof content === "string"
    ? content
    : content.map((b: { text: string }) => b.text).join("\n");
}

describe("envelope-aware clamp keeps the closing tag (ihunt)", () => {
  test("a >64KB Bash stdout still has an extractable <bash-stdout> body", () => {
    // 100KB of stdout — above the 64KB TUI clamp (and within the bash tool's
    // own 100KB output cap), so the clamp definitely fires.
    const stdout = "x".repeat(100 * 1024);
    const blocks = formatStructuredToolResult("Bash", "exec_command_end", {
      stdout,
      exitCode: 0,
    });
    const stored = storedString(makeToolResultMessage("call-bash", blocks));

    // The whole stored result must stay near the byte cap (proves the clamp
    // actually fired and the body did not pass through unclamped).
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_BYTES + 128,
    );
    // The closing tag must survive so the renderer can extract the body.
    expect(stored).toContain("</bash-stdout>");
    const extracted = extractToolTag(stored, "bash-stdout");
    expect(extracted).not.toBeNull();
    // The body carries the truncation marker (inside the envelope) so the user
    // knows output was cut; the kept head before it is a real prefix of stdout.
    expect(extracted!).toMatch(/\n\[\d+ bytes truncated\]$/);
    const head = extracted!.replace(/\n\[\d+ bytes truncated\]$/, "");
    expect(head.length).toBeGreaterThan(0);
    expect(stdout.startsWith(head)).toBe(true);
  });

  test("a >64KB Edit diff still has an extractable <edit-diff> body", () => {
    const diff = "+line\n".repeat(20_000); // ~120KB
    const blocks = formatStructuredToolResult("Edit", "tool_call_completed", {
      result: { diff, path: "/tmp/big.txt" },
    });
    const stored = storedString(makeToolResultMessage("call-edit", blocks));

    expect(stored).toContain("</edit-diff>");
    const extracted = extractToolTag(stored, "edit-diff");
    expect(extracted).not.toBeNull();
    expect(extracted!.length).toBeGreaterThan(0);
  });

  test("a >64KB FileRead content still has an extractable <read-content> body", () => {
    const content = "y".repeat(100 * 1024);
    const blocks = formatStructuredToolResult("FileRead", "tool_call_completed", {
      result: { content, path: "/tmp/big.log", startLine: 1, endLine: 99999 },
    });
    const stored = storedString(makeToolResultMessage("call-read", blocks));

    expect(stored).toContain("</read-content>");
    const extracted = extractToolTag(stored, "read-content");
    expect(extracted).not.toBeNull();
    expect(extracted!.length).toBeGreaterThan(0);
  });

  test("a >64KB Grep matches block still has an extractable <grep-matches> body", () => {
    const matches = Array.from({ length: 5_000 }, (_, i) => ({
      file: `/src/file-${i}.ts`,
      line: i,
      content: "some matching line content that adds up across many results",
    }));
    const blocks = formatStructuredToolResult("Grep", "tool_call_completed", {
      result: { matches, pattern: "foo" },
    });
    const stored = storedString(makeToolResultMessage("call-grep", blocks));

    expect(Buffer.byteLength(stored, "utf8")).toBeGreaterThan(
      MAX_TOOL_RESULT_BYTES,
    );
    expect(stored).toContain("</grep-matches>");
    const extracted = extractToolTag(stored, "grep-matches");
    expect(extracted).not.toBeNull();
    expect(extracted!.length).toBeGreaterThan(0);
  });

  test("the re-wrapped envelope stays within the byte cap (memory bound preserved)", () => {
    const stdout = "z".repeat(200 * 1024);
    const blocks = formatStructuredToolResult("Bash", "exec_command_end", {
      stdout,
      exitCode: 0,
    });
    const stored = storedString(makeToolResultMessage("call-cap", blocks));
    // Body clamp must respect the overall cap, leaving only small headroom for
    // tags + the truncation marker — not multiples of the cap.
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_BYTES + 128,
    );
  });
});
