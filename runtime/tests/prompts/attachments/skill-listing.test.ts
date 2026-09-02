/**
 * The skill listing must reach the model on every sampling request.
 * Attachment messages are never persisted into canonical history, so a
 * cross-turn hash gate hid the listing from the second request onward.
 */
import { describe, expect, test } from "vitest";

import { getAttachmentTrackingState } from "../../session/attachment-state.js";
import { SKILL_LISTING_REMINDER_HEADER } from "./messages.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";
import { skillListingProducer } from "./skill-listing.js";

function makeOpts(
  partial?: Partial<GetAttachmentsOptions>,
): GetAttachmentsOptions {
  return {
    sessionKey: {},
    userInput: null,
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: "/tmp/agenc-skill-listing-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
    agencHome: "/tmp/agenc-skill-listing-home",
    skillsManager: {
      skillsForConfig: async () => ({
        invokedSkills: [],
        availableSkills: [
          {
            name: "repo-docs",
            description: "Explain the repository docs",
            loadedFrom: "skills",
          },
        ],
      }),
    },
    ...partial,
  };
}

describe("skillListingProducer", () => {
  test("emits the listing on every request whose history does not carry it", async () => {
    const opts = makeOpts();
    const trackingState = getAttachmentTrackingState(opts.sessionKey);

    const first = await skillListingProducer(opts, trackingState);
    const second = await skillListingProducer(opts, trackingState);

    for (const out of [first, second]) {
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ kind: "skill_listing" });
      expect(out[0]).toHaveProperty(
        "content",
        expect.stringContaining("- repo-docs: Explain the repository docs"),
      );
    }
  });

  describe("the per-turn diagnostic", () => {
    const manySkills = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        name: `filler-${String(i).padStart(4, "0")}`,
        description: "a skill with a description long enough to consume budget",
        loadedFrom: "skills" as const,
        scope: "user" as const,
      }));

    function collect(partial?: Partial<GetAttachmentsOptions>) {
      const diagnostics: { cause: string; message: string }[] = [];
      const opts = makeOpts({
        emitDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        ...partial,
      });
      return { opts, diagnostics };
    }

    test("reports what the model was shown when the budget cut the listing", async () => {
      // The listing is an attachment, so it never reaches the rollout, and the
      // provider trace keeps no bodies. Without this, a run where the model
      // ignored every skill is indistinguishable from one where it was shown
      // none of the right ones.
      const { opts, diagnostics } = collect({
        contextWindowTokens: 20_000,
        skillsManager: {
          skillsForConfig: async () => ({
            invokedSkills: [],
            availableSkills: manySkills(200),
          }),
        },
      });

      await skillListingProducer(opts, getAttachmentTrackingState(opts.sessionKey));

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.cause).toBe("skill_listing_truncated");
      // The count includes whatever else the harness offers alongside them.
      expect(diagnostics[0]?.message).toMatch(/listed \d+ of \d+ invocable skills/);
      const [, listed, invocable] =
        /listed (\d+) of (\d+) invocable skills/.exec(diagnostics[0]?.message ?? "") ?? [];
      expect(Number(invocable)).toBeGreaterThanOrEqual(200);
      expect(Number(listed)).toBeLessThan(Number(invocable));
      expect(diagnostics[0]?.message).toContain("chars");
      expect(diagnostics[0]?.message).toContain("unranked");
    });

    test("says the listing was ranked when the request drove the order", async () => {
      const { opts, diagnostics } = collect({
        contextWindowTokens: 20_000,
        userInput: "write unit tests for the parser",
        skillsManager: {
          skillsForConfig: async () => ({
            invokedSkills: [],
            availableSkills: manySkills(200),
          }),
        },
      });

      await skillListingProducer(opts, getAttachmentTrackingState(opts.sessionKey));

      expect(diagnostics[0]?.message).toContain("ranked by this request");
    });

    test("names roots whose skills were never loaded at all", async () => {
      const { opts, diagnostics } = collect({
        contextWindowTokens: 20_000,
        skillsManager: {
          skillsForConfig: async () => ({
            invokedSkills: [],
            availableSkills: manySkills(200),
            truncatedSkillRoots: [
              { root: "/home/u/.agents/skills", droppedCount: 1_320 },
            ],
          }),
        },
      });

      await skillListingProducer(opts, getAttachmentTrackingState(opts.sessionKey));

      expect(diagnostics[0]?.message).toContain("1320 more were never loaded");
      expect(diagnostics[0]?.message).toContain("/home/u/.agents/skills holds 1320 past the per-root cap");
    });

    test("stays quiet when every skill fit", async () => {
      const { opts, diagnostics } = collect();
      await skillListingProducer(opts, getAttachmentTrackingState(opts.sessionKey));
      expect(diagnostics).toEqual([]);
    });

    test("never throws when no sink is provided", async () => {
      const opts = makeOpts({
        contextWindowTokens: 20_000,
        skillsManager: {
          skillsForConfig: async () => ({
            invokedSkills: [],
            availableSkills: manySkills(200),
          }),
        },
      });
      await expect(
        skillListingProducer(opts, getAttachmentTrackingState(opts.sessionKey)),
      ).resolves.toHaveLength(1);
    });
  });

  test("stays quiet when a message already carries the rendered listing", async () => {
    const rendered =
      `<system-reminder>\n${SKILL_LISTING_REMINDER_HEADER}\n\n- repo-docs: Explain the repository docs\n</system-reminder>`;
    const asString = makeOpts({
      messages: [
        { role: "system", content: "base prompt" },
        { role: "user", content: rendered },
        { role: "user", content: "hello" },
      ],
    });
    const asParts = makeOpts({
      messages: [
        { role: "user", content: [{ type: "text", text: rendered }] },
      ],
    });

    expect(
      await skillListingProducer(asString, getAttachmentTrackingState(asString.sessionKey)),
    ).toEqual([]);
    expect(
      await skillListingProducer(asParts, getAttachmentTrackingState(asParts.sessionKey)),
    ).toEqual([]);
  });

  test("emits nothing for subagents and skips skills that are not model-invocable", async () => {
    const subagent = makeOpts({ subagentDepth: 1 });
    expect(
      await skillListingProducer(subagent, getAttachmentTrackingState(subagent.sessionKey)),
    ).toEqual([]);

    const hiddenOnly = makeOpts({
      skillsManager: {
        skillsForConfig: async () => ({
          invokedSkills: [],
          availableSkills: [
            { name: "hidden-local", description: "Bulk edits", disableModelInvocation: true },
          ],
        }),
      },
    });
    // The runtime-registered bundled skills may still be listed; the
    // user-invocable-only local skill must not be.
    expect(
      JSON.stringify(
        await skillListingProducer(hiddenOnly, getAttachmentTrackingState(hiddenOnly.sessionKey)),
      ),
    ).not.toContain("hidden-local");
  });
});
