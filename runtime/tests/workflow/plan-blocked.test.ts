import { describe, expect, it } from "vitest";
import { PLAN_BLOCKED_KIND, parsePlanBlockedResponse, readPlanBlocked } from "../../src/app-server/workflow/plan-blocked.js";

const report = {
  kind: PLAN_BLOCKED_KIND,
  reason: "requirement_conflict",
  explanation: "The same strict value cannot equal both 0 and 1.",
  conflictingRequirements: ["Return a value strictly equal to 0.", "The same return value must strictly equal 1."],
};
const raw = JSON.stringify(report);

describe("explicit planner requirement conflicts", () => {
  it("accepts only a complete bounded control report and is stable after persistence", () => {
    const parsed = parsePlanBlockedResponse(`\n ${raw}\n`);
    expect(parsed).toEqual(report);
    expect(readPlanBlocked(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it.each([
    null, "", "This task is impossible.", "This task is ambiguous; please clarify.",
    `Plan: add a test for this marker: ${raw}`, `> ${raw}`, `\`\`\`json\n${raw}\n\`\`\``,
    JSON.stringify(raw), JSON.stringify([report]), JSON.stringify({ example: report }),
    `${raw}\nThen implement the normal feature.`, raw.slice(0, -1), `${raw}${raw}`,
  ])("does not halt for prose, examples or malformed responses: %s", response => {
    expect(parsePlanBlockedResponse(response)).toBeUndefined();
  });

  it.each([
    { reason: "ambiguous" }, { reason: "impossible" }, { kind: "agenc.goal.plan-blocked.v2" },
    { explanation: "" }, { explanation: "   " }, { explanation: "x".repeat(2001) },
    { conflictingRequirements: [] }, { conflictingRequirements: ["one"] },
    { conflictingRequirements: ["one", " one "] }, { conflictingRequirements: ["one two", "one\n two"] },
    { conflictingRequirements: ["one", ""] }, { conflictingRequirements: ["one", 2] },
    { conflictingRequirements: ["x".repeat(1001), "two"] },
    { conflictingRequirements: Array.from({ length: 9 }, (_, i) => `requirement ${i}`) },
    { extra: "not allowed" },
  ])("rejects invalid or ambiguous control fields: %j", change => {
    expect(parsePlanBlockedResponse(JSON.stringify({ ...report, ...change }))).toBeUndefined();
  });

  it("redacts before persisting report fields", () => {
    const secret = `sk-proj-${"a".repeat(24)}`;
    const parsed = parsePlanBlockedResponse(JSON.stringify({ ...report,
      explanation: `The requirement contains api_key=${secret}`,
      conflictingRequirements: [`Use api_key=${secret}`, "Do not use any API key"],
    }));
    expect(JSON.stringify(parsed)).not.toContain(secret);
    expect(JSON.stringify(parsed)).toContain("[REDACTED_SECRET]");
  });
});
