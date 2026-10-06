import { describe, expect, test, vi } from "vitest";

const reviewCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("../../src/session/agenc-delegate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/session/agenc-delegate.js")>()),
  buildGuardianReviewSessionConfig: () => ({}),
  runAgenCReviewOneShot: vi.fn(async (_session: unknown, req: Record<string, unknown>) => {
    reviewCalls.push(req);
    return { rawText: '{"verdict":"met","reason":"ok","unmet":[]}', verdict: "met" };
  }),
}));

import { defaultGoalGateDeps } from "../../src/goal/runtime-deps.js";

describe("the default goal judge", () => {
  test("runs inline in the worker's turn instead of spawning a Session task that would replace it", async () => {
    const ctx = { config: {}, modelInfo: { slug: "grok-test" } } as never;
    const raw = await defaultGoalGateDeps.judge({
      systemPrompt: "judge",
      userMessage: "goal",
      model: undefined,
      ctx,
      session: {} as never,
    });
    expect(raw).toContain('"verdict":"met"');
    expect(reviewCalls).toHaveLength(1);
    // A registered task aborts the live turn as "replaced" (Session.spawnTask).
    expect(reviewCalls[0]).toMatchObject({ registerTask: false, reuseKey: false, reviewerModel: "grok-test" });
  });
});
