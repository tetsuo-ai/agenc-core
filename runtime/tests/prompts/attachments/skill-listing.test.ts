/**
 * Restore missing skill listings, but do not drain further relevance batches
 * on every tool continuation of the same authoritative human turn.
 */
import { describe, expect, test } from "vitest";

import { getAttachmentTrackingState } from "../../session/attachment-state.js";
import { attachmentsToMessages, SKILL_LISTING_REMINDER_HEADER } from "./messages.js";
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
  test("identifies an explicitly mentioned plugin's skills even with an older retained listing", async () => {
    const text = "@stonks-copilot can u use this";
    const opts = makeOpts({
      userInput: text,
      messages: attachmentsToMessages([{ kind: "skill_listing", content: "- stock-analyzer: Analyze stocks" }]),
      turnProvenance: { turnId: "plugin-turn", rootHumanTurn: { turnId: "plugin-turn", text } },
      skillsManager: { skillsForConfig: async () => ({ availableSkills: [
        { name: "stock-analyzer", description: "Analyze stocks", pluginId: "stonks-copilot", loadedFrom: "plugin" },
        { name: "other-skill", description: "Other work", pluginId: "other-plugin", loadedFrom: "plugin" },
      ] }) },
    });
    const tracking = getAttachmentTrackingState(opts.sessionKey);
    tracking.listedSkillNames.add("stock-analyzer");
    expect(await skillListingProducer(opts, tracking)).toEqual([{
      kind: "skill_relevance", content: "- stock-analyzer: [plugin: stonks-copilot] Analyze stocks",
    }]);
    // Tool continuations do not repeat the reminder or invent a new human turn.
    expect(await skillListingProducer(opts, tracking)).toEqual([]);
  });

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

  test("the session listing records the names it showed", async () => {
    const opts = makeOpts();
    const tracking = getAttachmentTrackingState(opts.sessionKey);
    const result = await skillListingProducer(opts, tracking);
    expect(result.map((attachment) => attachment.kind)).toEqual(["skill_listing"]);
    // Bundled runtime skills join the listing too; the loaded one must be recorded.
    expect(tracking.listedSkillNames.has("repo-docs")).toBe(true);
  });

  test("once the listing is present, a request that names an unlisted skill gets a relevance block, once", async () => {
    const rendered =
      `<system-reminder>\n${SKILL_LISTING_REMINDER_HEADER}\n\n- repo-docs: Explain the repository docs\n</system-reminder>`;
    const opts = makeOpts({
      userInput: "write unit tests for the parser",
      turnProvenance: { turnId: "human-1", rootHumanTurn: { turnId: "human-1", text: "write unit tests for the parser" } },
      messages: [
        { role: "user", content: rendered, runtimeOnly: { mergeBoundary: "user_context" } },
        { role: "user", content: "write unit tests for the parser" },
      ],
      skillsManager: {
        skillsForConfig: async () => ({
          invokedSkills: [],
          availableSkills: [
            { name: "repo-docs", description: "Explain the repository docs", loadedFrom: "skills" },
            { name: "generating-unit-tests", description: "Write unit tests for a module", loadedFrom: "skills" },
            { name: "deploy-helm", description: "Deploy charts to a cluster", loadedFrom: "skills" },
          ],
        }),
      },
    });
    const tracking = getAttachmentTrackingState(opts.sessionKey);
    tracking.listedSkillNames.add("repo-docs");

    const first = await skillListingProducer(opts, tracking);
    expect(first).toHaveLength(1);
    expect(first[0]?.kind).toBe("skill_relevance");
    const content = (first[0] as { content: string }).content;
    expect(content).toContain("generating-unit-tests");
    expect(content).not.toContain("repo-docs");
    expect(content).not.toContain("deploy-helm");
    expect(tracking.listedSkillNames.has("generating-unit-tests")).toBe(true);

    // The same request again: every relevant name is already in front of the model.
    expect(await skillListingProducer(opts, tracking)).toEqual([]);
  });

  describe("root-human relevance cadence", () => {
    const request = "write unit tests for the parser";
    const rootTurn = (turnId: string) => ({ turnId, rootHumanTurn: { turnId, text: request } });
    const catalog = Array.from({ length: 60 }, (_, i) => ({
      name: `parser-testing-${String(i).padStart(2, "0")}`,
      description: "Write unit tests for the parser and verify parsing behavior carefully",
      loadedFrom: "skills",
    }));
    const catalogOptions = () => makeOpts({
      userInput: request,
      contextWindowTokens: 32_768,
      turnProvenance: rootTurn("human-1"),
      skillsManager: { skillsForConfig: async () => ({ availableSkills: catalog }) },
    });
    const retainedListing = attachmentsToMessages([{ kind: "skill_listing", content: "- prior: Prior skill" }]);

    test("the initial listing covers its human turn; later identical text with a new ID can get one batch", async () => {
      const opts = catalogOptions();
      const tracking = getAttachmentTrackingState(opts.sessionKey);
      const initial = await skillListingProducer(opts, tracking);
      expect(initial[0]?.kind).toBe("skill_listing");
      expect(tracking.lastSkillListingRootTurnId).toBe("human-1");
      const afterTool = { ...opts, messages: [
        ...attachmentsToMessages(initial),
        { role: "tool" as const, toolName: "FileRead", toolCallId: "read", content: "file contents" },
      ] };
      expect(await skillListingProducer(afterTool, tracking)).toEqual([]);
      expect(await skillListingProducer(afterTool, tracking)).toEqual([]);

      const nextTurn = { ...afterTool, turnProvenance: rootTurn("human-2") };
      const relevance = await skillListingProducer(nextTurn, tracking);
      expect(relevance[0]?.kind).toBe("skill_relevance");
      expect(tracking.lastSkillListingRootTurnId).toBe("human-2");
      expect(await skillListingProducer(nextTurn, tracking)).toEqual([]);
      expect((await skillListingProducer({ ...nextTurn, turnProvenance: rootTurn("human-3") }, tracking))[0]?.kind)
        .toBe("skill_relevance");
    });

    test("restores a missing listing on durable resume without claiming synthetic root authority", async () => {
      const opts = { ...catalogOptions(), turnProvenance: { turnId: "resumed-turn", rootHumanTurn: null } };
      const tracking = getAttachmentTrackingState(opts.sessionKey);
      const restored = await skillListingProducer(opts, tracking);
      expect(restored[0]?.kind).toBe("skill_listing");
      expect(tracking.lastSkillListingRootTurnId).toBeUndefined();
      expect(await skillListingProducer({ ...opts, messages: attachmentsToMessages(restored) }, tracking)).toEqual([]);
    });

    test("restores an evicted listing during the same turn without opening another relevance batch", async () => {
      const opts = catalogOptions();
      const tracking = getAttachmentTrackingState(opts.sessionKey);
      const initial = await skillListingProducer(opts, tracking);
      const restored = await skillListingProducer(opts, tracking);
      expect(restored).toEqual(initial);
      expect(await skillListingProducer({ ...opts, messages: attachmentsToMessages(restored) }, tracking)).toEqual([]);
    });

    test("requires exact authoritative provenance for relevance, not transcript/userInput text", async () => {
      for (const turnProvenance of [undefined, { turnId: "", rootHumanTurn: { turnId: "", text: request } },
        { turnId: "current", rootHumanTurn: { turnId: "stale", text: request } },
        { turnId: "current", rootHumanTurn: null }]) {
        const opts = { ...catalogOptions(), messages: retainedListing, turnProvenance };
        const tracking = getAttachmentTrackingState(opts.sessionKey);
        expect(await skillListingProducer(opts, tracking)).toEqual([]);
        expect(tracking.lastSkillListingRootTurnId).toBeUndefined();
      }
      const opts = { ...catalogOptions(), messages: retainedListing,
        turnProvenance: { turnId: "current", rootHumanTurn: { turnId: "current", text: "zzzz-unrelated" } } };
      expect(await skillListingProducer(opts, getAttachmentTrackingState(opts.sessionKey))).toEqual([]);
    });

    test("concurrent sampling preparation cannot drain two relevance batches for one human turn", async () => {
      const opts = { ...catalogOptions(), messages: retainedListing };
      const tracking = getAttachmentTrackingState(opts.sessionKey);
      const results = await Promise.all([skillListingProducer(opts, tracking), skillListingProducer(opts, tracking)]);
      expect(results.filter(result => result.length > 0)).toHaveLength(1);
    });

    test("aborted or failed catalog loading does not consume the human turn", async () => {
      const controller = new AbortController();
      const opts = { ...catalogOptions(), messages: retainedListing, signal: controller.signal,
        skillsManager: { skillsForConfig: async () => { controller.abort(); return { availableSkills: catalog }; } } };
      const tracking = getAttachmentTrackingState(opts.sessionKey);
      expect(await skillListingProducer(opts, tracking)).toEqual([]);
      expect(tracking.lastSkillListingRootTurnId).toBeUndefined();
      expect(tracking.listedSkillNames.size).toBe(0);
      const retry = { ...catalogOptions(), sessionKey: opts.sessionKey, messages: retainedListing };
      await expect(skillListingProducer({ ...retry, skillsManager: { skillsForConfig: async () => { throw new Error("loader failed"); } } }, tracking))
        .rejects.toThrow("loader failed");
      expect(tracking.lastSkillListingRootTurnId).toBeUndefined();
      expect((await skillListingProducer(retry, tracking))[0]?.kind).toBe("skill_relevance");
    });

    test("recognizes legacy retained listing headers without requiring their old unconditional instruction", async () => {
      const opts = { ...catalogOptions(), turnProvenance: { turnId: "resumed", rootHumanTurn: null }, messages: [{
        role: "user" as const,
        content: "<system-reminder>\nThe following skills are available for use with the Skill tool. If a skill matches the user's request, invoke the Skill tool before responding.\n\n- prior: Prior skill\n</system-reminder>",
      }] };
      expect(await skillListingProducer(opts, getAttachmentTrackingState(opts.sessionKey))).toEqual([]);
    });
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
