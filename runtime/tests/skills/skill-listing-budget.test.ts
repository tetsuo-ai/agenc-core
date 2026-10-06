import { afterEach, describe, expect, it } from "vitest";

import {
  buildSkillListingWithinBudget,
  type SkillListingEntry,
} from "../../src/skills/local-loader.js";

const skills: SkillListingEntry[] = Array.from({ length: 400 }, (_, i) => ({
  name: `skill-${String(i).padStart(3, "0")}`,
  description: `Does thing number ${i}. `.repeat(8),
  scope: "user",
}));

const original = process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET;
afterEach(() => {
  if (original === undefined) delete process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET;
  else process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = original;
});

describe("skill listing budget", () => {
  it("scales with the context window up to a fixed ceiling", () => {
    delete process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET;
    const small = buildSkillListingWithinBudget(skills, 200_000);
    const large = buildSkillListingWithinBudget(skills, 1_000_000);
    expect(small.stats.budgetChars).toBe(8_000);
    expect(large.stats.budgetChars).toBe(12_000);
    expect(large.listing.length).toBeLessThanOrEqual(12_000 + 200);
    expect(large.stats.listed).toBeGreaterThan(small.stats.listed);
    expect(large.stats.hidden).toBeGreaterThan(0);
  });

  it("keeps the default when the window is unknown and honours the env override", () => {
    delete process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET;
    expect(buildSkillListingWithinBudget(skills).stats.budgetChars).toBe(8_000);
    process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = "30000";
    expect(buildSkillListingWithinBudget(skills, 1_000_000).stats.budgetChars).toBe(30_000);
  });
});
