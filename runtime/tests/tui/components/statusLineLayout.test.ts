import { describe, expect, it, test } from "vitest";

import {
  layoutStatusLine,
  STATUS_LINE_BLOCK_GAP,
  STATUS_LINE_PADDING,
  statusLineGroupWidth,
  type PlacedStatusLineFact,
  type StatusLineFact,
} from "./statusLineLayout.js";
import {
  statusLineLeftFacts,
  statusLineRightFacts,
  statusLineSegments,
  statusLineUsageItems,
} from "./FullscreenLayout.js";
import type { ZeroDataRetentionStatus } from "../../llm/zero-data-retention.js";

const WIDTHS = [160, 120, 100, 80, 60, 50, 40] as const;
const RETAINED: ZeroDataRetentionStatus = { provider: "deepseek", state: "retained", reason: "DeepSeek keeps input." };

function facts(params: {
  readonly model: string;
  readonly effort: string | null;
  readonly spend: string;
  readonly offPeak?: boolean;
  readonly zdr?: ZeroDataRetentionStatus | null;
}): { readonly left: StatusLineFact[]; readonly right: StatusLineFact[] } {
  const segments = {
    ...statusLineSegments("~/project", params.model, "default", params.spend, params.effort, true),
    folderName: "project",
  };
  return {
    left: statusLineLeftFacts({ segments, mode: "default", swarm: null, shellCount: 0, runningAgents: 0 }),
    right: statusLineRightFacts(
      statusLineUsageItems(2, 82, segments.spend, params.offPeak ? "off-peak" : null),
      params.zdr === undefined ? RETAINED : params.zdr,
    ),
  };
}

const DEEPSEEK = facts({ model: "deepseek-flash", effort: "high effort", spend: "$0.0029", offPeak: true });
const LONG_MODEL = facts({ model: "qwen/qwen3-coder-30b-a3b-instruct", effort: null, spend: "price unknown" });
const UNKNOWN: ZeroDataRetentionStatus = { provider: "openrouter", state: "unknown", reason: "Requests go to 127.0.0.1." };
const LONG_MODEL_UNKNOWN_ZDR = facts({ model: "qwen/qwen3-coder-30b-a3b-instruct", effort: null, spend: "price unknown", zdr: UNKNOWN });

const text = (placed: readonly PlacedStatusLineFact[]) =>
  placed.map(fact => fact.spans.map(span => span.text).join("")).join(" · ");

function rendered(columns: number, set: typeof DEEPSEEK): string[] {
  const layout = layoutStatusLine(columns, set.left, set.right);
  return layout.rows === 1
    ? [`${text(layout.left)} | ${text(layout.right)}`]
    : [text(layout.left), text(layout.right)];
}

describe("status line layout", () => {
  it.each(WIDTHS)("keeps every fact and the ZDR badge on screen at %i columns", (columns) => {
    for (const set of [DEEPSEEK, LONG_MODEL, LONG_MODEL_UNKNOWN_ZDR]) {
      const layout = layoutStatusLine(columns, set.left, set.right);
      expect(layout.fits).toBe(true);
      expect([...layout.left, ...layout.right].map(fact => fact.key))
        .toEqual([...set.left, ...set.right].map(fact => fact.key));
      expect(layout.right.at(-1)).toEqual(set === LONG_MODEL_UNKNOWN_ZDR
        ? { key: "zdr", spans: [{ text: "ZDR?", color: "inactive" }] }
        : { key: "zdr", spans: [{ text: "ZDR", color: "error" }] });
      const available = columns - 2 * STATUS_LINE_PADDING;
      if (layout.rows === 1) {
        expect(statusLineGroupWidth(layout.left) + STATUS_LINE_BLOCK_GAP + statusLineGroupWidth(layout.right)).toBeLessThanOrEqual(available);
      } else {
        expect(statusLineGroupWidth(layout.left)).toBeLessThanOrEqual(available);
        expect(statusLineGroupWidth(layout.right)).toBeLessThanOrEqual(available);
      }
    }
  });

  it("shortens one readable step at a time, then wraps, from 160 down to 40 columns", () => {
    expect(Object.fromEntries(WIDTHS.map(columns => [columns, rendered(columns, DEEPSEEK)]))).toEqual({
      160: ["~/project · deepseek-flash · high effort · asks first | ctx 2% · cache 82% · $0.0029 off-peak · ZDR"],
      120: ["~/project · deepseek-flash · high effort · asks first | ctx 2% · cache 82% · $0.0029 off-peak · ZDR"],
      100: ["~/project · deepseek-flash · high · asks first | ctx 2% · cache 82% · $0.0029 off-peak · ZDR"],
      80: ["~/project · deepseek-flash · high · asks | ctx 2% · c 82% · $0.0029 op · ZDR"],
      // Two rows start again from the full forms.
      60: ["~/project · deepseek-flash · high effort · asks first", "ctx 2% · cache 82% · $0.0029 off-peak · ZDR"],
      50: ["~/project · deepseek-flash · high · asks first", "ctx 2% · cache 82% · $0.0029 off-peak · ZDR"],
      40: ["project · deepse…flash · high · asks", "ctx 2% · c 82% · $0.0029 op · ZDR"],
    });
  });

  it("shortens a long model name in the middle, never below a readable floor on one row", () => {
    expect(Object.fromEntries(WIDTHS.map(columns => [columns, rendered(columns, LONG_MODEL)]))).toEqual({
      160: ["~/project · qwen/qwen3-coder-30b-a3b-instruct · asks first | ctx 2% · cache 82% · price unknown · ZDR"],
      120: ["~/project · qwen/qwen3-coder-30b-a3b-instruct · asks first | ctx 2% · cache 82% · price unknown · ZDR"],
      100: ["~/project · qwen/qwen3-coder-30b-a3b-instruct · asks | ctx 2% · cache 82% · price unknown · ZDR"],
      80: ["project · qwen/qwen3-co…a3b-instruct · asks | ctx 2% · c 82% · no price · ZDR"],
      60: ["~/project · qwen/qwen3-coder-30b-a3b-instruct · asks", "ctx 2% · cache 82% · price unknown · ZDR"],
      50: ["project · qwen/qwen3-cod…b-a3b-instruct · asks", "ctx 2% · cache 82% · price unknown · ZDR"],
      40: ["project · qwen/qwen…-instruct · asks", "ctx 2% · c 82% · price unknown · ZDR"],
    });
    // The one-row floor (16 columns) holds: below it the line wraps instead.
    const oneRow = layoutStatusLine(80, LONG_MODEL.left, LONG_MODEL.right);
    expect(oneRow.rows).toBe(1);
    const model = oneRow.left.find(fact => fact.key === "model")!.spans[0]!.text;
    expect(model.length).toBeGreaterThanOrEqual(16);
  });

  it("says no price for a price it does not know once the row runs short", () => {
    const layout = layoutStatusLine(40, LONG_MODEL_UNKNOWN_ZDR.left, LONG_MODEL_UNKNOWN_ZDR.right);
    expect(text(layout.right)).toBe("ctx 2% · c 82% · no price · ZDR?");
    expect(layout.right.find(fact => fact.key === "spend")).toEqual({ key: "spend", spans: [{ text: "no price", color: "text" }] });
  });

  it("keeps the usage colors in the short forms: names in secondary ink, figures in the value color", () => {
    const layout = layoutStatusLine(80, DEEPSEEK.left, DEEPSEEK.right);
    expect(layout.right).toEqual([
      { key: "ctx", spans: [{ text: "ctx ", color: "text2" }, { text: "2%", color: "accentSoft" }] },
      { key: "cache", spans: [{ text: "c ", color: "text2" }, { text: "82%", color: "accentSoft" }] },
      { key: "spend", spans: [{ text: "$0.0029", color: "accentSoft" }, { text: " op", color: "text2" }] },
      { key: "zdr", spans: [{ text: "ZDR", color: "error" }] },
    ]);
  });

  it("colors the badge by what happens to the data", () => {
    const badge = (zdr: ZeroDataRetentionStatus | null) =>
      statusLineRightFacts([], zdr).find(fact => fact.key === "zdr")?.forms;
    expect(badge({ provider: "cerebras", state: "zdr", reason: "r" })).toEqual([[{ text: "ZDR", color: "success" }]]);
    expect(badge({ provider: "grok", state: "retained", reason: "r" })).toEqual([[{ text: "ZDR", color: "error" }]]);
    expect(badge({ provider: "openai-compatible", state: "unknown", reason: "r" })).toEqual([[{ text: "ZDR?", color: "inactive" }]]);
    // Before the session's provider is known there is nothing true to show.
    expect(badge(null)).toBeUndefined();
  });

  it("keeps a session that never asks in full words and in its warning color", () => {
    const segments = statusLineSegments("~/project", "grok-4.6", "bypassPermissions", "$0.10", "high effort", true);
    const left = statusLineLeftFacts({ segments, mode: "bypassPermissions", swarm: null, shellCount: 0, runningAgents: 0 });
    const layout = layoutStatusLine(40, left, statusLineRightFacts([], RETAINED));
    expect(layout.left.find(fact => fact.key === "mode")).toEqual({
      key: "mode",
      spans: [{ text: "never asks", color: "error", bold: true }],
    });
  });

  it("stays on one row when there is nothing to move", () => {
    const set = facts({ model: "grok-4.6", effort: null, spend: "", zdr: null });
    const usage = statusLineRightFacts(statusLineUsageItems(null, null, null, null), null);
    expect(layoutStatusLine(40, set.left, usage)).toMatchObject({ rows: 1, right: [] });
  });
});


test("manual web search has a monochrome footer marker only when On", () => {
  expect(statusLineRightFacts([], null, false)).toEqual([]);
  expect(statusLineRightFacts([], null, true)).toEqual([
    { key: "web-search", forms: [[{ text: "Web", color: "subtle" }]] },
  ]);
});
