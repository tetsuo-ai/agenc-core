import { describe, expect, test } from "vitest";
import type { Session } from "../../src/session/session.js";
import { assembleSystemPromptSnapshot } from "../../src/prompts/system-prompt.js";
import { mkCtx } from "../fixtures.js";
import { LIGHT_MISSING_CHECK_TOOLS } from "../../src/prompts/light-budget-prompt.js";

async function head(input: { nonInteractive: boolean; exactOutput?: boolean; styled?: boolean; provider?: string }) {
  const provider = input.provider ?? "deepseek";
  const session = {
    services: {
      runtimeOptions: { lightMode: true, nonInteractive: input.nonInteractive, exactOutput: input.exactOutput },
      providerEnvironment: {},
    },
  } as unknown as Session;
  return (await assembleSystemPromptSnapshot({
    profile: "light", ctx: mkCtx(), session, provider,
    promptIdentity: { provider, model: provider === "deepseek" ? "deepseek-flash" : "gpt-6-luna" },
    ...(input.styled ? { outputStyle: { name: "custom", prompt: "Reply concisely." } } : {}),
  })).staticPrefix;
}

describe("Light noninteractive acceptance review", () => {
  test.each([false, true])("retains the contract even when exactOutput=%s", async exactOutput => {
    const prompt = await head({ nonInteractive: true, exactOutput });
    expect(prompt).toMatch(/acceptance checklist.*user's request/);
    expect(prompt).toContain("paths, formats, exact bytes and numeric bounds");
    expect(prompt).toContain("Carry it through summaries");
    expect(prompt).toContain("check each item against the delivered result");
    expect(prompt).toContain("provided reference unchanged");
    expect(prompt).toContain("not from your implementation");
    expect(prompt).not.toContain("Report unavailable checks instead of rebuilding their tools");
  });

  test.each(["deepseek", "openai"])("bounds missing-tool recovery for %s", async provider => {
    const prompt = await head({ nonInteractive: true, provider });
    expect(prompt).toContain("one time-bounded setup attempt");
    expect(prompt).toContain("within permissions and the remaining budget");
    expect(prompt).toContain("isolated environment");
    expect(prompt).toContain("Do not retry failed setup");
    expect(prompt).toContain("report what remains unverified");
  });

  test("an output style changes presentation without removing acceptance obligations", async () => {
    const prompt = await head({ nonInteractive: true, styled: true });
    expect(prompt).toContain("acceptance checklist");
    expect(prompt).toContain("one time-bounded setup attempt");
  });

  test("interactive Light retains its existing token budget and finish policy", async () => {
    const prompt = await head({ nonInteractive: false });
    expect(prompt).not.toContain("acceptance checklist");
    expect(prompt).not.toContain("one time-bounded setup attempt");
    expect(prompt).toContain(LIGHT_MISSING_CHECK_TOOLS);
    expect(prompt).not.toContain("Report unavailable checks instead of rebuilding their tools");
  });

  test.each(["deepseek", "openai"])("bounds the added static prompt for %s", async provider => {
    const before = await head({ nonInteractive: false, provider });
    const after = await head({ nonInteractive: true, provider });
    expect(after.length - before.length).toBeGreaterThan(0);
    expect(after.length - before.length).toBeLessThanOrEqual(provider === "deepseek" ? 400 : 800);
  });
});
