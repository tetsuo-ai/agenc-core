/**
 * The daemon rebuilds a durably resumed skill turn from its journal record:
 * the skill must still be in the skill registry, from the same source and
 * with the same settings, and its settings are admitted again under the
 * current policy. The resumed turn keeps the skill's model, effort and (at
 * most) grants; the next turn runs on the session's settings. Anything else
 * resumes on the session's settings with a warning saying why.
 */
import { afterEach, describe, expect, test } from "vitest";

import {
  admitSkillInvocation,
  resumeSkillInvocationTurn,
} from "../../src/app-server/background-agent-runner/skill-invocation.js";
import type { LLMTool } from "../../src/llm/types.js";
import { buildProviderOptions } from "../../src/phases/stream-model.js";
import type { Session } from "../../src/session/session.js";
import {
  skillInvocationRecord,
  type SkillInvocationRecord,
} from "../../src/session/skill-invocation.js";
import { skillInvocationSettingsFor } from "../../src/skills/skill-invocation-settings.js";
import {
  deepSeekSkillTurnSession,
  reloadManagedPolicy,
  removeSkillTurnHomes,
} from "../helpers/skill-turn-session.js";

afterEach(() => {
  removeSkillTurnHomes();
});

/** The skill as the registry has it (frontmatter as loaded). */
const DEEP_REVIEW_SKILL = {
  name: "deep-review",
  source: "userSettings",
  loadedFrom: "skills",
  path: "/home/user/.agenc/skills/deep-review/SKILL.md",
  root: "/home/user/.agenc/skills",
  scope: "user",
  model: "deepseek-v4-pro",
  effort: "low",
  allowedTools: ["Write, exec_command(git status:*)"],
};

type RegistrySkill = typeof DEEP_REVIEW_SKILL | Record<string, unknown>;

function sessionWithRegistry(
  registry: { skill: RegistrySkill | null },
  options: { readonly managedPolicy?: boolean } = {},
): { readonly session: Session; readonly warnings: Array<{ cause: string; message: string }> } {
  const session = deepSeekSkillTurnSession({
    ...(options.managedPolicy === true ? { managedPolicy: true } : {}),
    skillsManager: {
      resolveSkill: async (name: string) =>
        registry.skill !== null && registry.skill.name === name ? registry.skill : null,
    },
  });
  const warnings: Array<{ cause: string; message: string }> = [];
  const emit = session.emit.bind(session);
  (session as { emit: Session["emit"] }).emit = (event, opts) => {
    if (event.msg.type === "warning") {
      const payload = event.msg.payload as { cause?: string; message?: string };
      warnings.push({ cause: String(payload.cause), message: String(payload.message) });
    }
    return emit(event, opts);
  };
  return { session, warnings };
}

/** The record the journal keeps for the skill turn the TUI started. */
async function journaledRecord(session: Session): Promise<SkillInvocationRecord> {
  const settings = skillInvocationSettingsFor(DEEP_REVIEW_SKILL)!;
  const admitted = await admitSkillInvocation(session, session.services.configStore!, settings);
  return skillInvocationRecord(session.newSkillInvocationTurn(admitted.overrides).skillInvocation!);
}

function request(): Parameters<typeof buildProviderOptions>[0] {
  return {
    input: [{ role: "user", content: "hi" }],
    tools: [] as LLMTool[],
    parallelToolCalls: false,
    baseInstructions: "",
  } as unknown as Parameters<typeof buildProviderOptions>[0];
}

describe("resuming a skill turn", () => {
  test("the resumed turn keeps the skill's settings; the next turn runs on the session's", async () => {
    const { session, warnings } = sessionWithRegistry({ skill: DEEP_REVIEW_SKILL });
    const record = await journaledRecord(session);
    expect(record).toMatchObject({
      name: "deep-review",
      source: "userSettings",
      model: "deepseek-v4-pro",
      effort: "low",
      allowedTools: ["Write", "exec_command(git status:*)", "Skill(deep-review)"],
    });

    const resumed = await resumeSkillInvocationTurn(
      session,
      session.services.configStore!,
      { turnId: "turn-interrupted", skillInvocation: record },
    );
    expect(warnings).toEqual([]);
    expect(resumed?.subId).toBe("turn-interrupted");
    expect(resumed?.skillInvocation).toMatchObject({
      name: "deep-review",
      model: "deepseek-v4-pro",
      effort: "low",
      allowedTools: ["Write", "exec_command(git status:*)", "Skill(deep-review)"],
    });
    const signal = new AbortController().signal;
    const resumedOptions = buildProviderOptions(request(), resumed!, signal, session);
    expect(resumedOptions.model).toBe("deepseek-v4-pro");
    expect(resumedOptions.reasoningEffort).toBe("low");

    const next = session.newDefaultTurn();
    expect(next.skillInvocation).toBeUndefined();
    const nextOptions = buildProviderOptions(request(), next, signal, session);
    expect(nextOptions).not.toHaveProperty("model");
    expect(nextOptions.reasoningEffort).toBe("high");
  });

  test.each([
    ["the skill is gone", null, /skill deep-review is no longer available/u],
    ["its effort changed", { ...DEEP_REVIEW_SKILL, effort: "max" }, /skill deep-review changed since the turn started/u],
    ["it gained a grant", { ...DEEP_REVIEW_SKILL, allowedTools: ["Write, exec_command"] }, /changed since the turn started/u],
    ["it moved to a plugin", { ...DEEP_REVIEW_SKILL, source: "plugin", loadedFrom: "plugin" }, /changed since the turn started/u],
    ["it is now a project skill", { ...DEEP_REVIEW_SKILL, source: "projectSettings" }, /changed since the turn started/u],
  ] as const)("resumes on the session's settings when %s", async (_case, registered, reason) => {
    const registry: { skill: RegistrySkill | null } = { skill: DEEP_REVIEW_SKILL };
    const { session, warnings } = sessionWithRegistry(registry);
    const record = await journaledRecord(session);
    registry.skill = registered;
    await expect(resumeSkillInvocationTurn(
      session,
      session.services.configStore!,
      { turnId: "turn-interrupted", skillInvocation: record },
    )).resolves.toBeUndefined();
    expect(warnings).toEqual([{
      cause: "durable_resume_skill_settings_dropped",
      message: expect.stringMatching(reason),
    }]);
  });

  test("an unreadable record resumes on the session's settings", async () => {
    const { session, warnings } = sessionWithRegistry({ skill: DEEP_REVIEW_SKILL });
    await expect(resumeSkillInvocationTurn(
      session,
      session.services.configStore!,
      { turnId: "turn-interrupted", skillInvocation: { name: "deep-review" } },
    )).resolves.toBeUndefined();
    expect(warnings).toEqual([{
      cause: "durable_resume_skill_settings_dropped",
      message: expect.stringContaining("cannot be read"),
    }]);
  });

  test("a managed-only policy that came in while the daemon was down withholds the grants", async () => {
    const { session, warnings } = sessionWithRegistry({ skill: DEEP_REVIEW_SKILL }, { managedPolicy: true });
    const record = await journaledRecord(session);
    await reloadManagedPolicy(session, ["allowManagedPermissionRulesOnly = true"]);
    const resumed = await resumeSkillInvocationTurn(
      session,
      session.services.configStore!,
      { turnId: "turn-interrupted", skillInvocation: record },
    );
    expect(resumed?.skillInvocation).toMatchObject({
      model: "deepseek-v4-pro",
      effort: "low",
      allowedTools: [],
    });
    expect(warnings).toEqual([expect.objectContaining({ cause: "skill_tool_grants_withheld" })]);
  });

  test("a turn whose grants policy withheld at the start gets none after the policy lifts", async () => {
    const { session } = sessionWithRegistry({ skill: DEEP_REVIEW_SKILL }, { managedPolicy: true });
    await reloadManagedPolicy(session, ["allowManagedPermissionRulesOnly = true"]);
    const record = await journaledRecord(session);
    expect(record.allowedTools).toEqual([]);
    await reloadManagedPolicy(session, []);
    const resumed = await resumeSkillInvocationTurn(
      session,
      session.services.configStore!,
      { turnId: "turn-interrupted", skillInvocation: record },
    );
    expect(resumed?.skillInvocation?.allowedTools).toEqual([]);
    expect(resumed?.skillInvocation?.model).toBe("deepseek-v4-pro");
  });
});
