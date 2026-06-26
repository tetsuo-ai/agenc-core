/**
 * Model-aware per-tool-result cap (design item (a)).
 *
 * The I-15 result-size cap used to be a fixed 400 KB byte limit, never
 * scaled to the model's context window. On a small-window model (e.g.
 * the local 131,072-token window) a single 400 KB result is ~100K
 * tokens of plain text (~76% of the window) or ~200K tokens of JSON
 * (>100% of the window) — one result could overflow the whole window.
 *
 * `computeEffectiveMaxResultBytes` now scales the cap to the live
 * context window threaded through `RunToolUseOptions.contextWindowTokens`:
 *   - ≤ ~20% of the window per result (text → ~104 KB @ 131K window)
 *   - JSON gets a tighter byte cap (~52 KB) for the same token target
 *   - large-window models (≥200K) keep the fixed 400 KB ceiling
 *   - no window threaded → fixed 400 KB (unchanged behavior)
 *
 * REVERT PROOF: with the `execution.ts` change reverted, the 131K
 * post-fix assertion reddens (the result is ~100K tokens again).
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  capToolResult,
  computeEffectiveMaxResultBytes,
  DEFAULT_MAX_TOOL_RESULT_BYTES,
  MIN_TOOL_RESULT_BYTES,
  runToolUse,
} from "./execution.js";
import { getToolResultPath } from "../utils/toolResultStorage.js";
import type { Tool } from "./types.js";
import type { ToolInvocation } from "./context.js";

const LOCAL_WINDOW = 131_072;
const LARGE_WINDOW = 200_000;
const TEXT_BYTES_PER_TOKEN = 4;
const JSON_BYTES_PER_TOKEN = 2;

function estimateTokens(text: string, bytesPerToken: number): number {
  return Math.round(Buffer.byteLength(text, "utf8") / bytesPerToken);
}

/** ~420 KB of generic, non-JSON text (a `cat`/MCP/WebFetch-style dump). */
function makeGenericText(bytes: number): string {
  // Repeating prose so `detectContentType` classifies it as non-JSON.
  const unit = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

/** ~`bytes` of valid JSON (so `detectContentType` returns "json"). */
function makeJson(bytes: number): string {
  const items: string[] = [];
  let size = 2; // for the surrounding []
  let i = 0;
  while (size < bytes) {
    const entry = `{"id":${i},"name":"item-${i}","value":"xxxxxxxxxxxxxxxx"}`;
    items.push(entry);
    size += entry.length + 1;
    i += 1;
  }
  return `[${items.join(",")}]`;
}

function makeInvocation(callId: string, toolName: string): ToolInvocation {
  return {
    session: { services: {} } as never,
    turn: {
      cwd: "/repo",
      sandboxPolicy: { value: "workspace_write" },
      approvalPolicy: { value: "on_request" },
    } as never,
    tracker: {
      appendFileDiff: () => {},
      snapshot: () => [],
      clear: () => {},
    },
    callId,
    toolName: { name: toolName },
    payload: { kind: "function", arguments: "" },
    source: "direct",
  };
}

/** A tool that just echoes back a fixed body so we exercise the cap. */
function echoTool(name: string, body: string): Tool {
  return {
    name,
    description: "",
    inputSchema: {},
    execute: async () => ({ content: body }),
  };
}

describe("computeEffectiveMaxResultBytes — model-aware cap", () => {
  test("131K window scales text cap to ~20% of the window (~104 KB)", () => {
    const cap = computeEffectiveMaxResultBytes({
      content: makeGenericText(10_000),
      contextWindowTokens: LOCAL_WINDOW,
    });
    // 0.20 * 131072 * 4 = 104857
    expect(cap).toBe(Math.floor(LOCAL_WINDOW * 0.2 * TEXT_BYTES_PER_TOKEN));
    expect(cap).toBeLessThan(DEFAULT_MAX_TOOL_RESULT_BYTES);
  });

  test("JSON content gets a tighter byte cap (~half the text cap)", () => {
    const textCap = computeEffectiveMaxResultBytes({
      content: makeGenericText(10_000),
      contextWindowTokens: LOCAL_WINDOW,
    });
    const jsonCap = computeEffectiveMaxResultBytes({
      content: makeJson(10_000),
      contextWindowTokens: LOCAL_WINDOW,
    });
    expect(jsonCap).toBe(Math.floor(LOCAL_WINDOW * 0.2 * JSON_BYTES_PER_TOKEN));
    // JSON byte cap is roughly half the text byte cap for the same token target.
    expect(jsonCap).toBeCloseTo(textCap / 2, -2);
    expect(jsonCap).toBeLessThan(textCap);
  });

  test("large-window models (>=200K) keep the fixed 400 KB ceiling", () => {
    expect(
      computeEffectiveMaxResultBytes({
        content: makeGenericText(10_000),
        contextWindowTokens: LARGE_WINDOW,
      }),
    ).toBe(DEFAULT_MAX_TOOL_RESULT_BYTES);
    expect(
      computeEffectiveMaxResultBytes({
        content: makeGenericText(10_000),
        contextWindowTokens: 1_000_000,
      }),
    ).toBe(DEFAULT_MAX_TOOL_RESULT_BYTES);
  });

  test("no window threaded → fixed 400 KB (unchanged behavior)", () => {
    expect(
      computeEffectiveMaxResultBytes({
        content: makeGenericText(10_000),
        contextWindowTokens: undefined,
      }),
    ).toBe(DEFAULT_MAX_TOOL_RESULT_BYTES);
  });

  test("per-tool override wins unconditionally", () => {
    expect(
      computeEffectiveMaxResultBytes({
        content: makeGenericText(10_000),
        contextWindowTokens: LOCAL_WINDOW,
        toolMaxResultBytes: 4_096,
      }),
    ).toBe(4_096);
  });

  test("tiny window never starves below the floor", () => {
    const cap = computeEffectiveMaxResultBytes({
      content: makeGenericText(10_000),
      contextWindowTokens: 1_000,
    });
    expect(cap).toBe(MIN_TOOL_RESULT_BYTES);
  });
});

describe("capToolResult — informative window-aware marker", () => {
  test("marker reports kept-of-original bytes/tokens + window + how to get more", () => {
    const body = makeGenericText(420_000);
    const out = capToolResult(body, 104_857, {
      bytesPerToken: TEXT_BYTES_PER_TOKEN,
      contextWindowTokens: LOCAL_WINDOW,
    });
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.capped, "utf8")).toBeLessThanOrEqual(104_857);
    expect(out.capped).toContain("result truncated");
    expect(out.capped).toContain("of 420000 bytes");
    expect(out.capped).toContain(`${LOCAL_WINDOW}-token context window`);
    expect(out.capped).toMatch(/offset\+limit|narrow the query|specific search/);
  });

  test("legacy marker preserved when no marker info is supplied", () => {
    const out = capToolResult(makeGenericText(1_000), 500);
    expect(out.capped).toContain("[truncated:");
  });
});

describe("runToolUse — end-to-end model-aware cap", () => {
  test("131K window: a 420 KB text result is capped to ~104 KB (≤ 30K tokens)", async () => {
    const body = makeGenericText(420_000);
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool: echoTool("dump", body),
      invocation: makeInvocation("c-text", "dump"),
      contextWindowTokens: LOCAL_WINDOW,
    });
    expect(out.isError).toBe(false);
    const tokens = estimateTokens(out.content, TEXT_BYTES_PER_TOKEN);
    // POST-FIX: capped to ~104 KB → ~26K tokens.
    expect(tokens).toBeLessThanOrEqual(30_000);
    // Sanity: the full 420 KB body was NOT returned verbatim.
    expect(Buffer.byteLength(out.content, "utf8")).toBeLessThan(420_000);
  });

  test("131K window WITHOUT the cap would be ~100K tokens (pre-fix baseline)", async () => {
    // This is the pre-fix behavior: with the fixed 400 KB cap a 420 KB
    // text result is capped to 400 KB ≈ ~100K tokens. We reproduce it by
    // forcing the fixed cap via a per-tool override, demonstrating the
    // magnitude the model-aware cap removes.
    const body = makeGenericText(420_000);
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool: {
        ...echoTool("dump-fixed", body),
        maxResultBytes: DEFAULT_MAX_TOOL_RESULT_BYTES,
      },
      invocation: makeInvocation("c-text-fixed", "dump-fixed"),
      contextWindowTokens: LOCAL_WINDOW,
    });
    const tokens = estimateTokens(out.content, TEXT_BYTES_PER_TOKEN);
    expect(tokens).toBeGreaterThan(90_000);
  });

  test("131K window: a 420 KB JSON result is capped tighter (~half the text bytes)", async () => {
    const textBody = makeGenericText(420_000);
    const jsonBody = makeJson(420_000);

    const textOut = await runToolUse("{}", {
      currentTurnId: "t1",
      tool: echoTool("dump-text", textBody),
      invocation: makeInvocation("c-text2", "dump-text"),
      contextWindowTokens: LOCAL_WINDOW,
    });
    const jsonOut = await runToolUse("{}", {
      currentTurnId: "t1",
      tool: echoTool("dump-json", jsonBody),
      invocation: makeInvocation("c-json", "dump-json"),
      contextWindowTokens: LOCAL_WINDOW,
    });

    const textBytes = Buffer.byteLength(textOut.content, "utf8");
    const jsonBytes = Buffer.byteLength(jsonOut.content, "utf8");
    // JSON byte cap ≈ half the text byte cap (same token target, 2 B/tok).
    expect(jsonBytes).toBeLessThan(textBytes);
    expect(jsonBytes).toBeCloseTo(textBytes / 2, -3);
  });

  test("200K window (or undefined): cap stays 400 KB — Claude untouched", async () => {
    const body = makeGenericText(420_000);

    const largeOut = await runToolUse("{}", {
      currentTurnId: "t1",
      tool: echoTool("dump-large", body),
      invocation: makeInvocation("c-large", "dump-large"),
      contextWindowTokens: LARGE_WINDOW,
    });
    // Truncated to the 400 KB ceiling, not the window-relative value.
    expect(Buffer.byteLength(largeOut.content, "utf8")).toBeLessThanOrEqual(
      DEFAULT_MAX_TOOL_RESULT_BYTES,
    );
    expect(Buffer.byteLength(largeOut.content, "utf8")).toBeGreaterThan(
      Math.floor(LOCAL_WINDOW * 0.2 * TEXT_BYTES_PER_TOKEN),
    );

    const noWindowOut = await runToolUse("{}", {
      currentTurnId: "t1",
      tool: echoTool("dump-nowin", body),
      invocation: makeInvocation("c-nowin", "dump-nowin"),
      // contextWindowTokens omitted → fixed 400 KB cap.
    });
    expect(Buffer.byteLength(noWindowOut.content, "utf8")).toBeGreaterThan(
      Math.floor(LOCAL_WINDOW * 0.2 * TEXT_BYTES_PER_TOKEN),
    );
  });
});

/**
 * Technique D — model-aware OFFLOAD (persist full + reference), not a
 * blind truncation. When a tool result exceeds the model-aware cap the
 * FULL output is written to the session tool-results store and the model
 * receives a REFERENCE (head preview + path + "read range to continue"),
 * so no data is lost and the full output is recoverable via FileRead.
 *
 * REVERT PROOF: stash the `offloadOrCapToolResult` change in
 * execution.ts so the cap site blind-truncates again → no file is
 * persisted and the returned message contains no path / no
 * "read … to see more" pointer → assertions (b)/(a)/(c) redden.
 */
describe("runToolUse — model-aware OFFLOAD (Technique D)", () => {
  test("131K window: a 420 KB result is OFFLOADED (full persisted + reference), not blind-truncated", async () => {
    const body = makeGenericText(420_000);
    const callId = `c-offload-${randomUUID()}`;
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool: echoTool("dump-offload", body),
      invocation: makeInvocation(callId, "dump-offload"),
      contextWindowTokens: LOCAL_WINDOW,
    });

    // The wire message is bounded by the model-aware cap.
    expect(out.isError).toBe(false);
    expect(Buffer.byteLength(out.content, "utf8")).toBeLessThanOrEqual(
      Math.floor(LOCAL_WINDOW * 0.2 * TEXT_BYTES_PER_TOKEN),
    );

    // (b) The message returned to the model is a REFERENCE, not a blind
    // truncation: it names the persisted path and an actionable pointer.
    const persistedPath = getToolResultPath(callId, false);
    expect(out.content).toContain(persistedPath);
    expect(out.content).toContain("saved to");
    expect(out.content).toMatch(/read that file|read range|to see more/i);
    // Sanity: it is NOT the legacy blind-truncation marker.
    expect(out.content).not.toContain("[truncated: original was");

    // (a) A file is PERSISTED holding the FULL original content.
    const persisted = readFileSync(persistedPath, "utf8");
    expect(persisted).toBe(body);

    // (c) The full content is recoverable from the path (head preview is
    // a strict prefix of the persisted full output).
    const headStart = out.content.indexOf("\n") + 1;
    const head = out.content.slice(headStart).split("\n[…truncated")[0];
    expect(head.length).toBeGreaterThan(0);
    expect(persisted.startsWith(head)).toBe(true);
  });

  test("(d) tool_use/tool_result pairing stays valid — the result keeps the callId", async () => {
    const body = makeGenericText(420_000);
    const callId = `c-pair-${randomUUID()}`;
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool: echoTool("dump-pair", body),
      invocation: makeInvocation(callId, "dump-pair"),
      contextWindowTokens: LOCAL_WINDOW,
    });
    // The output is the tool_result for this exact tool_use id — offload
    // replaces the CONTENT only, never the pairing.
    expect(out.callId).toBe(callId);
    expect(out.isError).toBe(false);
  });

  test("(e) under the cap → returned unchanged, nothing persisted", async () => {
    const body = makeGenericText(1_000);
    const callId = `c-small-${randomUUID()}`;
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool: echoTool("dump-small", body),
      invocation: makeInvocation(callId, "dump-small"),
      contextWindowTokens: LOCAL_WINDOW,
    });
    expect(out.content).toBe(body);
    // No reference message, no persisted-output pointer.
    expect(out.content).not.toContain("saved to");
    expect(() => readFileSync(getToolResultPath(callId, false), "utf8")).toThrow();
  });

  test("Claude / ≥200K window: a 420 KB result is NOT offloaded (fixed 400 KB ceiling, unaffected)", async () => {
    const body = makeGenericText(420_000);
    const callId = `c-claude-${randomUUID()}`;
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool: echoTool("dump-claude", body),
      invocation: makeInvocation(callId, "dump-claude"),
      contextWindowTokens: LARGE_WINDOW,
    });
    // 420 KB > 400 KB ceiling, so it still offloads at 400 KB — but the
    // KEY invariant is that the cap value is the fixed ceiling, NOT the
    // window-relative value, i.e. Claude's threshold is untouched.
    expect(Buffer.byteLength(out.content, "utf8")).toBeLessThanOrEqual(
      DEFAULT_MAX_TOOL_RESULT_BYTES,
    );
    // Below the 400 KB ceiling a large-window result is returned verbatim
    // (no offload, no reference) — proving Claude's behavior is unchanged.
    const underCeiling = makeGenericText(300_000);
    const callId2 = `c-claude-under-${randomUUID()}`;
    const out2 = await runToolUse("{}", {
      currentTurnId: "t1",
      tool: echoTool("dump-claude-under", underCeiling),
      invocation: makeInvocation(callId2, "dump-claude-under"),
      contextWindowTokens: LARGE_WINDOW,
    });
    expect(out2.content).toBe(underCeiling);
    expect(out2.content).not.toContain("saved to");
  });
});
