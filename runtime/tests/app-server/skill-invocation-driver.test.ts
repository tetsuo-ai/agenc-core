/**
 * The daemon turn driver runs the turn a user starts by invoking a skill with
 * the skill's model, effort and grants, and every other turn with the
 * session's own settings.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { __installDaemonTurnDriverHooksForTest } from "../../src/app-server/background-agent-runner.js";
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

describe("daemon turn driver and skill invocations", () => {
  test("the daemon turn driver builds the skill turn for that submission only", async () => {
    const session = deepSeekSession();
    const turns: TurnContext[] = [];
    const runTurnFn = vi.fn(async function* (_session: unknown, ctx: TurnContext) {
      turns.push(ctx);
    });
    __installDaemonTurnDriverHooksForTest(
      session as never,
      session.services.configStore as never,
      runTurnFn as never,
    );

    await session.submit("review the diff", { skillInvocation: DEEP_REVIEW });
    await session.submit("plain follow-up");

    expect(turns).toHaveLength(2);
    expect(turns[0]?.skillInvocation).toEqual({
      name: "deep-review",
      model: "deepseek-v4-pro",
      allowedTools: ["Write", "exec_command(git status:*)", "Skill(deep-review)"],
    });
    expect(turns[0]?.reasoningEffort).toBe("low");
    expect(turns[0]?.modelInfo.slug).toBe("deepseek-v4-pro");
    expect(turns[1]?.skillInvocation).toBeUndefined();
    expect(turns[1]?.reasoningEffort).toBe("high");
    expect(turns[1]?.modelInfo.slug).toBe("deepseek-flash");
  });

  test("a skill turn the session cannot honor fails before the turn runs", async () => {
    const session = deepSeekSession();
    const runTurnFn = vi.fn(async function* () {});
    __installDaemonTurnDriverHooksForTest(
      session as never,
      session.services.configStore as never,
      runTurnFn as never,
    );
    await expect(
      session.submit("review", { skillInvocation: { name: "x", model: "gpt-6-luna" } }),
    ).rejects.toThrow(/this session runs on deepseek/u);
    expect(runTurnFn).not.toHaveBeenCalled();
  });
  test("managed-only policy runs the skill turn without grants and says so", async () => {
    policy.managedOnly = true;
    const session = deepSeekSession();
    const warnings: unknown[] = [];
    session.eventLog.subscribe((event) => {
      if (event.msg.type === "warning") warnings.push(event.msg.payload);
    });
    const turns: TurnContext[] = [];
    __installDaemonTurnDriverHooksForTest(
      session as never,
      session.services.configStore as never,
      (async function* (_session: unknown, ctx: TurnContext) {
        turns.push(ctx);
      }) as never,
    );

    await session.submit("review the diff", { skillInvocation: DEEP_REVIEW });

    expect(turns[0]?.skillInvocation?.allowedTools).toEqual([]);
    expect(turns[0]?.modelInfo.slug).toBe("deepseek-v4-pro");
    expect(warnings).toContainEqual(expect.objectContaining({
      cause: "skill_tool_grants_withheld",
    }));
  });
});
