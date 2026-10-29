import { describe, expect, test, vi } from "vitest";
import { buildToolRegistry } from "../../tool-registry.js";
import { getAttachmentTrackingState } from "../../session/attachment-state.js";
import { attachmentsToMessages } from "./messages.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";
import { skillListingProducer } from "./skill-listing.js";
import type { SkillListingEntry } from "../../skills/local-loader.js";

const installed = (scope: string) => ({ name: "house-style", description: "Apply the house style", loadedFrom: "skills", scope });
const bundled = { name: "verify", description: "Verify changes", loadedFrom: "bundled" };

function fixture(skills: readonly SkillListingEntry[], options: { lightMode?: boolean; disabled?: boolean; retained?: boolean; aborted?: boolean; subagentDepth?: number } = {}) {
  const registry = buildToolRegistry({
    workspaceRoot: "/var/tmp/skill-availability", lightMode: options.lightMode ?? true, deferRareTools: true,
    requireAdmission: false,
    toolsConfig: { disabled_tools: options.disabled ? ["Skill"] : [] },
    modelFacingTools: [{ name: "Skill", description: "Load a skill", recoveryCategory: "side-effecting", inputSchema: { type: "object", properties: { skill: { type: "string" } }, required: ["skill"] },
      execute: async () => ({ content: "loaded" }) }],
  });
  const ensureSkillTool = vi.fn(() => {
    registry.discoverToolNames?.(["Skill"]);
    return registry.toLLMTools().some(tool => tool.function.name === "Skill");
  });
  const controller = new AbortController();
  if (options.aborted) controller.abort();
  const opts: GetAttachmentsOptions = {
    sessionKey: {}, userInput: "Apply the house style to this paragraph.",
    loadedTools: registry.toLLMTools(),
    messages: options.retained ? attachmentsToMessages([{ kind: "skill_listing", content: "- house-style: Apply the house style" }]) : [],
    permissionContext: { mode: "default" } as never,
    cwd: "/var/tmp/skill-availability", subagentDepth: options.subagentDepth ?? 0,
    signal: controller.signal, agencHome: "/var/tmp/skill-availability-home",
    lightMode: options.lightMode ?? true,
    skillsManager: { skillsForConfig: async () => ({ availableSkills: skills }) },
    ensureSkillTool,
  };
  return { registry, opts, ensureSkillTool, tracking: getAttachmentTrackingState(opts.sessionKey) };
}

describe("installed skill invocation availability", () => {
  test.each(["project", "user", "plugin"])("loads Skill before the first Light request for %s skills, without an explicit name mention", async scope => {
    const f = fixture([bundled, installed(scope)]);
    expect(f.registry.toLLMTools().some(tool => tool.function.name === "Skill")).toBe(false);
    const listing = await skillListingProducer(f.opts, f.tracking);
    expect(f.registry.toLLMTools().some(tool => tool.function.name === "Skill")).toBe(true);
    expect(listing).toEqual([{ kind: "skill_listing", content: "- house-style: Apply the house style", skillToolListed: true }]);
    expect(attachmentsToMessages(listing)[0]?.content).toContain("If a skill fits, use Skill.");
    expect(attachmentsToMessages(listing)[0]?.content).not.toContain("Otherwise");
  });

  test("restores invocation after resume even when the listing is retained", async () => {
    const f = fixture([installed("user")], { retained: true });
    expect(await skillListingProducer(f.opts, f.tracking)).toEqual([]);
    expect(f.ensureSkillTool).toHaveBeenCalledOnce();
    expect(f.registry.toLLMTools().some(tool => tool.function.name === "Skill")).toBe(true);
  });

  test.each([[], [bundled], [{ ...installed("user"), disableModelInvocation: true }]].map(skills => [skills]))("preserves the no-invocable-installed-skills tools byte for byte %#", async skills => {
    const f = fixture(skills);
    const before = JSON.stringify(f.registry.toLLMTools());
    expect(await skillListingProducer(f.opts, f.tracking)).toEqual([]);
    expect(f.ensureSkillTool).not.toHaveBeenCalled();
    expect(JSON.stringify(f.registry.toLLMTools())).toBe(before);
  });

  test("keeps standard mode's already visible Skill and listing", async () => {
    const f = fixture([installed("project")], { lightMode: false });
    const before = JSON.stringify(f.registry.toLLMTools());
    expect((await skillListingProducer(f.opts, f.tracking))[0]).toMatchObject({ skillToolListed: true });
    expect(f.ensureSkillTool).not.toHaveBeenCalled();
    expect(JSON.stringify(f.registry.toLLMTools())).toBe(before);
  });

  test("does not override disabled tools or claim a disabled schema is callable", async () => {
    const f = fixture([installed("project")], { disabled: true });
    const listing = await skillListingProducer(f.opts, f.tracking);
    expect(f.registry.toLLMTools().some(tool => tool.function.name === "Skill")).toBe(false);
    expect(listing[0]).not.toHaveProperty("skillToolListed");
  });

  test.each([{ aborted: true }, { subagentDepth: 1 }])("does not load tools outside a live root preparation %#", async options => {
    const f = fixture([installed("user")], options);
    expect(await skillListingProducer(f.opts, f.tracking)).toEqual([]);
    expect(f.ensureSkillTool).not.toHaveBeenCalled();
  });

  test("does not override a session policy excluding Skill", async () => {
    const f = fixture([installed("user")]);
    const opts = { ...f.opts, toolPolicy: { enabledTools: ["exec_command"] } as never };
    expect(await skillListingProducer(opts, f.tracking)).toEqual([]);
    expect(f.ensureSkillTool).not.toHaveBeenCalled();
  });
});
