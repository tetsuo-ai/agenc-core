import { describe, expect, it } from "vitest";

import {
  BRIDGE_SAFE_COMMAND_NAMES,
  isBridgeForwardablePromptCommand,
  isBridgeSafeCommand,
} from "../../src/commands/bridge-policy.js";
import {
  BRIDGE_SAFE_COMMANDS,
  getCommandsSync,
  isBridgeSafeCommand as commandObjectPolicy,
  isBridgeForwardablePromptCommand as commandPromptPolicy,
} from "../../src/commands.js";
import { isBridgeSafeCommand as dispatcherPolicy } from "../../src/commands/dispatcher.js";
import { isBridgeSafeCommand as cliPolicy } from "../../src/bin/slash.js";

describe("bridge command policy contract", () => {
  it("keeps one frozen list of approved canonical names", () => {
    expect(BRIDGE_SAFE_COMMAND_NAMES).toEqual([
      "clear", "diff", "help", "hello", "model", "provider", "status",
    ]);
    expect(Object.isFrozen(BRIDGE_SAFE_COMMAND_NAMES)).toBe(true);
    expect([...BRIDGE_SAFE_COMMANDS].map((command) => command.name).sort()).toEqual(
      [...BRIDGE_SAFE_COMMAND_NAMES].sort(),
    );
  });

  it("exports the same policy through command objects, dispatcher, and CLI", () => {
    expect(commandObjectPolicy).toBe(isBridgeSafeCommand);
    expect(dispatcherPolicy).toBe(isBridgeSafeCommand);
    expect(cliPolicy).toBe(isBridgeSafeCommand);
    expect(commandPromptPolicy).toBe(isBridgeForwardablePromptCommand);
  });

  it("keeps every registered command name and command object consistent", () => {
    for (const command of getCommandsSync()) {
      const expected = BRIDGE_SAFE_COMMAND_NAMES.includes(command.name);
      expect(command.type).toBe("local");
      expect(isBridgeSafeCommand(command)).toBe(expected);
      expect(cliPolicy(command.name)).toBe(expected);
      expect(BRIDGE_SAFE_COMMANDS.has(command)).toBe(expected);
      expect(isBridgeForwardablePromptCommand(command)).toBe(false);
    }
  });

  it.each(["reset", "new", "quit", "unknown", "Help", "/help", " help", "help ", ""])(
    "does not normalize or trust the raw name %j",
    (name) => {
      expect(isBridgeSafeCommand(name)).toBe(false);
      expect(isBridgeSafeCommand({ name, type: "local" })).toBe(false);
    },
  );

  it("does not execute display-name callbacks or trust aliases", () => {
    const command = {
      type: "local" as const,
      name: "unsafe",
      aliases: ["help"],
      userFacingName: () => { throw new Error("must not run"); },
    };
    expect(isBridgeSafeCommand(command)).toBe(false);
    expect(isBridgeSafeCommand({ ...command, name: "help" })).toBe(true);
  });

  it.each([...BRIDGE_SAFE_COMMAND_NAMES, "project-skill"])(
    "keeps prompt forwarding and local JSX separate for %s",
    (name) => {
      const prompt = { name, type: "prompt" as const };
      const localJsx = { name, type: "local-jsx" as const };
      expect(isBridgeSafeCommand(prompt)).toBe(false);
      expect(isBridgeSafeCommand(localJsx)).toBe(false);
      expect(isBridgeForwardablePromptCommand(prompt)).toBe(true);
      expect(isBridgeForwardablePromptCommand(localJsx)).toBe(false);
    },
  );
});
