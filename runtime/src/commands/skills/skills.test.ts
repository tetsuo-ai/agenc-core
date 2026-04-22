import React from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  commandsPath: new URL("../../commands.js", import.meta.url).pathname,
  skillsMenuPath: new URL(
    "../../components/skills/SkillsMenu.js",
    import.meta.url,
  ).pathname,
}));

vi.mock(mocks.commandsPath, () => ({
  getCommandName: (command: { name: string; userFacingName?: () => string }) =>
    command.userFacingName?.() ?? command.name,
}));

vi.mock(mocks.skillsMenuPath, () => ({
  SkillsMenu: function SkillsMenuMock() {
    return null;
  },
}));

import { SkillsMenu } from "../../components/skills/SkillsMenu.js";
import { call } from "./skills.js";

function makeSkillCommand(overrides: Record<string, unknown> = {}) {
  return {
    type: "prompt",
    name: "review",
    description: "Review the current diff",
    loadedFrom: "skills",
    source: "projectSettings",
    progressMessage: "running review",
    contentLength: 0,
    aliases: [],
    async getPromptForCommand() {
      return [];
    },
    ...overrides,
  };
}

function makeContext(commands: unknown[]) {
  return {
    options: {
      commands,
    },
  } as never;
}

describe("/skills command adapter", () => {
  it("shows the skills dialog when no lookup arg is provided", async () => {
    const onDone = vi.fn();
    const commands = [makeSkillCommand()];

    const result = await call(onDone, makeContext(commands), "");

    expect(React.isValidElement(result)).toBe(true);
    expect(result?.type).toBe(SkillsMenu);
    expect(result?.props).toMatchObject({
      onExit: onDone,
      commands,
    });
    expect(onDone).not.toHaveBeenCalled();
  });

  it("routes an exact skill lookup into the resolved slash command", async () => {
    const onDone = vi.fn();
    const commands = [makeSkillCommand({ name: "review" })];

    const result = await call(onDone, makeContext(commands), "review src/app.ts");

    expect(result).toBeNull();
    expect(onDone).toHaveBeenCalledWith(undefined, {
      display: "skip",
      nextInput: "/review src/app.ts",
      submitNextInput: true,
    });
  });

  it("routes plugin skills by leaf name and preserves the plugin-prefixed command", async () => {
    const onDone = vi.fn();
    const commands = [
      makeSkillCommand({
        name: "frontend:lint",
        loadedFrom: "plugin",
        source: "plugin",
      }),
    ];

    const result = await call(onDone, makeContext(commands), "lint --fix");

    expect(result).toBeNull();
    expect(onDone).toHaveBeenCalledWith(undefined, {
      display: "skip",
      nextInput: "/frontend:lint --fix",
      submitNextInput: true,
    });
  });

  it("falls back to the dialog when a lookup is ambiguous", async () => {
    const onDone = vi.fn();
    const commands = [
      makeSkillCommand({
        name: "alpha:review",
        loadedFrom: "plugin",
        source: "plugin",
      }),
      makeSkillCommand({
        name: "beta:review",
        loadedFrom: "plugin",
        source: "plugin",
      }),
    ];

    const result = await call(onDone, makeContext(commands), "review");

    expect(React.isValidElement(result)).toBe(true);
    expect(result?.type).toBe(SkillsMenu);
    expect(onDone).not.toHaveBeenCalled();
  });
});
