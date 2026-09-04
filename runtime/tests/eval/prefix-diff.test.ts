import { describe, expect, it } from "vitest";
import { describeDivergence, firstDivergence, reportPrefixStability } from "../../scripts/eval/prefix-diff.mjs";

const base = {
  instructions: "You are the agent.",
  input: [
    { role: "system", content: "static head" },
    { role: "user", content: "first prompt" },
  ],
  tools: [{ name: "FileRead", parameters: { a: 1 } }, { name: "Write", parameters: { b: 2 } }],
};

describe("firstDivergence", () => {
  it("treats appended input items as an unchanged prefix", () => {
    const next = { ...base, input: [...base.input, { role: "assistant", content: "ok" }, { role: "tool", content: "done" }] };
    expect(firstDivergence(base, next)).toBeNull();
    expect(describeDivergence(null)).toContain("unchanged");
  });

  it("locates a change inside the instructions with its offset", () => {
    const next = { ...base, instructions: "You are the agent. Time: 12:01" };
    const divergence = firstDivergence(base, next);
    expect(divergence).toMatchObject({ field: "instructions", index: -1, offsetChars: 18, approxTokens: 5 });
    expect(divergence?.after).toContain("Time: 12:01");
  });

  it("locates a rewritten input item and counts the bytes before it", () => {
    const next = { ...base, input: [base.input[0], { role: "user", content: "first prompt, edited" }] };
    const divergence = firstDivergence(base, next);
    expect(divergence?.field).toBe("input");
    expect(divergence?.index).toBe(1);
    expect(divergence?.role).toBe("user");
    // instructions plus the whole first item precede the differing byte.
    expect(divergence?.offsetChars).toBeGreaterThan(base.instructions.length + JSON.stringify(base.input[0]).length);
    expect(describeDivergence(divergence)).toContain("input[1] (user)");
  });

  it("reports tool list churn by name and schema", () => {
    const next = { ...base, tools: [{ name: "Write", parameters: { b: 2 } }, { name: "FileRead", parameters: { a: 1, c: 3 } }, { name: "Grep", parameters: {} }] };
    const divergence = firstDivergence(base, next);
    expect(divergence).toMatchObject({ field: "tools", added: ["Grep"], removed: [], reordered: true, changedSchemas: ["FileRead"] });
    expect(describeDivergence(divergence)).toContain("added Grep");
  });

  it("reports removed input items as a divergence at the removal point", () => {
    const next = { ...base, input: [base.input[0]] };
    expect(firstDivergence(base, next)).toMatchObject({ field: "input", index: 1, removed: 1 });
  });

  it("summarizes a run of requests", () => {
    const requests = [
      { seq: 1, body: base },
      { seq: 2, body: { ...base, input: [...base.input, { role: "assistant", content: "ok" }] } },
      { seq: 3, body: { ...base, instructions: "You are the agent!", input: [...base.input, { role: "assistant", content: "ok" }] } },
    ];
    const lines = reportPrefixStability(requests);
    expect(lines[0]).toContain("#1 -> #2: prefix unchanged");
    expect(lines[1]).toContain("#2 -> #3: instructions (system) at offset 17 chars");
    expect(lines.at(-1)).toBe("3 requests, 2 pairs, 1 with an unchanged prefix");
  });
});
