/**
 * A skill the user invokes by name runs its turn with the model, effort and
 * tool grants its frontmatter declares; the session keeps its own settings,
 * so the next turn runs on them again.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  admitSkillInvocation,
  SkillInvocationRejectedError,
} from "../../src/app-server/background-agent-runner/skill-invocation.js";
import type { LLMTool } from "../../src/llm/types.js";
import { hasPermissionsToUseTool } from "../../src/permissions/evaluator.js";
import { withTurnCommandAllowRules } from "../../src/permissions/permission-updates.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import {
  buildLiveToolDispatchOptions,
} from "../../src/phases/execute-tools.js";
import { buildProviderOptions } from "../../src/phases/stream-model.js";
import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import type { SkillInvocationSettings } from "../../src/session/skill-invocation.js";
import type { TurnContext } from "../../src/session/turn-context.js";
import {
  deepSeekSkillTurnSession as deepSeekSession,
  removeSkillTurnHomes,
} from "../helpers/skill-turn-session.js";

const policy = vi.hoisted(() => ({ managedOnly: false }));

vi.mock("../../src/permissions/settings.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../src/permissions/settings.js")
  >();
  return {
    ...original,
    readPermissionRulesSnapshot: (
      store: Parameters<typeof original.readPermissionRulesSnapshot>[0],
    ) => ({
      ...original.readPermissionRulesSnapshot(store),
      ...(policy.managedOnly ? { managedOnly: true } : {}),
    }),
  };
});

afterEach(() => {
  policy.managedOnly = false;
  removeSkillTurnHomes();
});

const DEEP_REVIEW: SkillInvocationSettings = {
  name: "deep-review",
  model: "deepseek-v4-pro",
  effort: "low",
  allowedTools: ["Write", " exec_command(git status:*) ", "Write"],
};

function request(): Parameters<typeof buildProviderOptions>[0] {
  return {
    input: [{ role: "user", content: "hi" }],
    tools: [] as LLMTool[],
    parallelToolCalls: false,
    baseInstructions: "",
  } as unknown as Parameters<typeof buildProviderOptions>[0];
}

describe("skill invocation admission", () => {
  test("admits a model of the session's provider, an effort it takes and canonical grants", async () => {
    const session = deepSeekSession();
    const admitted = await admitSkillInvocation(
      session,
      session.services.configStore!,
      DEEP_REVIEW,
    );
    expect(admitted.withheldGrants).toEqual([]);
    expect(admitted.overrides.invocation).toEqual({
      name: "deep-review",
      requested: {
        model: "deepseek-v4-pro",
        effort: "low",
        allowedTools: ["Write", " exec_command(git status:*) ", "Write"],
      },
      model: "deepseek-v4-pro",
      effort: "low",
      allowedTools: ["Write", "exec_command(git status:*)", "Skill(deep-review)"],
    });
    expect(admitted.overrides.modelInfo?.slug).toBe("deepseek-v4-pro");
  });

  test.each([
    [{ name: "x", model: "gpt-6-luna" }, /on openai, but this session runs on deepseek/u],
    [{ name: "x", model: "deepseek-v9-imaginary" }, /cannot use/u],
    [{ name: "x", effort: "medium" }, /does not support \(supported: low, high, max\)/u],
    [{ name: "x", effort: "turbo" }, /must be one of/u],
    [{ name: "x", allowedTools: ["exec_command(git"] }, /not a permission rule/u],
  ] as const)("refuses %j", async (settings, message) => {
    const session = deepSeekSession();
    await expect(
      admitSkillInvocation(session, session.services.configStore!, settings),
    ).rejects.toThrow(SkillInvocationRejectedError);
    await expect(
      admitSkillInvocation(session, session.services.configStore!, settings),
    ).rejects.toThrow(message);
  });

  test("the session's model needs no override and its effort carries over", async () => {
    const session = deepSeekSession();
    const admitted = await admitSkillInvocation(
      session,
      session.services.configStore!,
      { name: "same", model: "deepseek-flash" },
    );
    expect(admitted.overrides.invocation).toEqual({
      name: "same",
      requested: { model: "deepseek-flash" },
      allowedTools: ["Skill(same)"],
    });
    expect(admitted.overrides.invocation).not.toHaveProperty("effort");
    expect(admitted.overrides).not.toHaveProperty("modelInfo");
  });

  test("managed-only permission policy withholds the grants and keeps the rest", async () => {
    const session = deepSeekSession();
    policy.managedOnly = true;
    const admitted = await admitSkillInvocation(
      session,
      session.services.configStore!,
      DEEP_REVIEW,
    );
    expect(admitted.overrides.invocation.allowedTools).toEqual([]);
    expect(admitted.withheldGrants).toEqual(["Write", "exec_command(git status:*)"]);
    expect(admitted.overrides.invocation.model).toBe("deepseek-v4-pro");
  });
});

describe("skill invocation turn", () => {
  test("the skill turn requests the skill's model and effort; the next turn the session's", async () => {
    const session = deepSeekSession();
    const admitted = await admitSkillInvocation(
      session,
      session.services.configStore!,
      DEEP_REVIEW,
    );
    const skillTurn = session.newSkillInvocationTurn(admitted.overrides);
    const nextTurn = session.newDefaultTurn();
    const signal = new AbortController().signal;

    const skillOptions = buildProviderOptions(request(), skillTurn, signal, session);
    expect(skillOptions.model).toBe("deepseek-v4-pro");
    expect(skillOptions.reasoningEffort).toBe("low");
    expect(skillTurn.modelInfo.slug).toBe("deepseek-v4-pro");
    expect(skillTurn.config.model).toBe("deepseek-v4-pro");

    const nextOptions = buildProviderOptions(request(), nextTurn, signal, session);
    expect(nextOptions).not.toHaveProperty("model");
    expect(nextOptions.reasoningEffort).toBe("high");
    expect(nextTurn.skillInvocation).toBeUndefined();
    expect(session.sessionConfiguration.collaborationMode).toEqual({
      model: "deepseek-flash",
      reasoningEffort: "high",
    });
    expect(session.config.model).toBe("deepseek-flash");
  });

  test("a provider switch inside the turn stops the skill's model override", async () => {
    const session = deepSeekSession();
    const admitted = await admitSkillInvocation(
      session,
      session.services.configStore!,
      DEEP_REVIEW,
    );
    const skillTurn = session.newSkillInvocationTurn(admitted.overrides);
    const switched = {
      ...skillTurn,
      providerBinding: { ...skillTurn.providerBinding, revision: skillTurn.providerBinding.revision - 1 },
    } as TurnContext;
    const options = buildProviderOptions(request(), switched, new AbortController().signal, session);
    expect(options).not.toHaveProperty("model");
  });

  test("grants join the turn's permission snapshot only, never the registry", async () => {
    const session = deepSeekSession();
    const admitted = await admitSkillInvocation(
      session,
      session.services.configStore!,
      DEEP_REVIEW,
    );
    const skillTurn = session.newSkillInvocationTurn(admitted.overrides);
    const write = { name: "Write", checkPermissions: undefined };
    const ask = async (ctx: TurnContext) => {
      const options = buildLiveToolDispatchOptions(ctx, session);
      return (await hasPermissionsToUseTool(
        write as never,
        { file_path: "/tmp/notes.txt", content: "x" },
        options.permissionContext!,
      )).behavior;
    };

    const skillSnapshot = buildLiveToolDispatchOptions(skillTurn, session)
      .permissionContext!.getAppState().toolPermissionContext;
    expect(skillSnapshot.alwaysAllowRules.command).toEqual([
      "Write",
      "exec_command(git status:*)",
      "Skill(deep-review)",
    ]);
    expect(await ask(skillTurn)).toBe("allow");
    expect(await ask(session.newDefaultTurn())).toBe("ask");
    expect(
      session.permissionModeRegistry.current().alwaysAllowRules.command,
    ).toBeUndefined();
  });

  test("the model may load the invoked skill again in its turn without a prompt", async () => {
    const session = deepSeekSession({
      skillsManager: {
        resolveSkill: async (name: string) => ({ name, model: "deepseek-v4-pro" }),
      },
    });
    const admitted = await admitSkillInvocation(
      session,
      session.services.configStore!,
      DEEP_REVIEW,
    );
    const skillTurn = session.newSkillInvocationTurn(admitted.overrides);
    const skillTool = createModelFacingTools({
      workspaceRoot: "/tmp",
      getSession: () => session,
    }).find((tool) => tool.name === "Skill")!;
    const decide = async (ctx: TurnContext, skill: string) =>
      (await skillTool.checkPermissions!(
        { skill },
        buildLiveToolDispatchOptions(ctx, session).permissionContext! as never,
      )).behavior;

    expect(await decide(skillTurn, "deep-review")).toBe("allow");
    expect(await decide(skillTurn, "other-skill")).toBe("ask");
    expect(await decide(session.newDefaultTurn(), "deep-review")).toBe("ask");
  });

  test("a deny rule still wins over a grant, and auto mode drops dangerous grants", async () => {
    const session = deepSeekSession({
      permissionContext: createEmptyToolPermissionContext({
        alwaysDenyRules: { userSettings: ["Write"] },
      }),
    });
    const admitted = await admitSkillInvocation(
      session,
      session.services.configStore!,
      DEEP_REVIEW,
    );
    const skillTurn = session.newSkillInvocationTurn(admitted.overrides);
    const decision = await hasPermissionsToUseTool(
      { name: "Write", checkPermissions: undefined } as never,
      { file_path: "/tmp/notes.txt", content: "x" },
      buildLiveToolDispatchOptions(skillTurn, session).permissionContext!,
    );
    expect(decision.behavior).toBe("deny");
    const auto = withTurnCommandAllowRules(
      createEmptyToolPermissionContext({ mode: "auto", autoModeActive: true }),
      ["exec_command", "Write"],
    );
    expect(auto.alwaysAllowRules.command).toEqual(["Write"]);
  });
});
