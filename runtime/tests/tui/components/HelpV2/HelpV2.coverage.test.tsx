import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Command } from "../../../commands.js";

const keybindingMock = vi.hoisted(() => ({
  groups: [] as Array<{
    handlers: Record<string, () => void>;
    options: { context?: string; isActive?: boolean };
  }>,
  singles: [] as Array<{
    action: string;
    handler: () => void;
    options: { context?: string; isActive?: boolean };
  }>,
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("../../keybindings/useKeybinding.js", () => ({
  useKeybinding: (
    action: string,
    handler: () => void,
    options: { context?: string; isActive?: boolean } = {},
  ) => {
    keybindingMock.singles.push({ action, handler, options });
  },
  useKeybindings: (
    handlers: Record<string, () => void>,
    options: { context?: string; isActive?: boolean } = {},
  ) => {
    keybindingMock.groups.push({ handlers, options });
  },
}));

vi.mock("../../keybindings/loadUserBindings.js", () => ({
  isKeybindingCustomizationEnabled: () => false,
}));

vi.mock("../../../utils/fastMode.js", () => ({
  isFastModeAvailable: () => false,
  isFastModeEnabled: () => false,
}));

vi.mock("../../../utils/platform.js", () => ({
  getPlatform: () => "linux",
}));

import { createRoot, type Root } from "../../ink.js";
import { HelpV2 } from "./HelpV2.js";

function sleep(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function testCommand(
  name: string,
  description: string,
  overrides: Partial<Command> = {},
): Command {
  return {
    type: "prompt",
    name,
    description,
    progressMessage: "running",
    contentLength: description.length,
    ...overrides,
  } as Command;
}

function invokeSingle(action: string): void {
  const registration = [...keybindingMock.singles]
    .reverse()
    .find(
      candidate =>
        candidate.action === action && candidate.options.isActive !== false,
    );

  if (!registration) throw new Error(`No active keybinding for ${action}`);
  registration.handler();
}

function invokeGroup(action: string): void {
  const registration = [...keybindingMock.groups]
    .reverse()
    .find(
      candidate =>
        candidate.handlers[action] !== undefined &&
        candidate.options.isActive !== false,
    );

  if (!registration) throw new Error(`No active keybinding group for ${action}`);
  registration.handlers[action]?.();
}

function createStreams(): {
  stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  stdout: PassThrough;
  output: () => string;
} {
  let rendered = "";
  const stdout = new PassThrough();
  stdout.on("data", chunk => {
    rendered += chunk.toString();
  });
  (stdout as unknown as { columns: number; rows: number }).columns = 120;
  (stdout as unknown as { columns: number; rows: number }).rows = 24;

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};

  return {
    stdin,
    stdout,
    output: () => stripAnsi(rendered),
  };
}

async function renderHelp(commands: Command[]): Promise<{
  dispose: () => void;
  onClose: ReturnType<typeof vi.fn>;
  output: () => string;
  root: Root;
}> {
  const { stdin, stdout, output } = createStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  const onClose = vi.fn();

  root.render(<HelpV2 commands={commands} onClose={onClose} query="deploy" />);
  await sleep();

  return {
    root,
    onClose,
    output,
    dispose: () => {
      root.unmount();
      stdin.end();
      stdout.end();
    },
  };
}

describe("HelpV2 coverage", () => {
  beforeEach(() => {
    keybindingMock.groups = [];
    keybindingMock.singles = [];
  });

  it("routes visible built-in and custom commands through tabs and dismisses via help keybinding", async () => {
    const harness = await renderHelp([
      testCommand("help", "Show help"),
      testCommand("status", "Hidden status command", { isHidden: true }),
      testCommand("deploy-project", "Deploy the project", { source: "plugin" }),
      testCommand("internal-project", "Hidden project command", {
        isHidden: true,
        source: "plugin",
      }),
    ]);

    try {
      const generalOutput = harness.output();
      expect(generalOutput).toContain("AgenC Help");
      expect(generalOutput).toContain("AgenC understands your codebase");

      invokeSingle("help:dismiss");
      expect(harness.onClose).toHaveBeenCalledWith("Help dialog dismissed", {
        display: "system",
      });

      invokeGroup("tabs:next");
      await sleep();

      expect(harness.output()).toContain("Default commands matching deploy:");
      expect(harness.output()).toContain("/help");
      expect(harness.output()).not.toContain("/status");

      invokeGroup("tabs:next");
      await sleep();

      expect(harness.output()).toContain("Custom commands matching deploy:");
      expect(harness.output()).toContain("/deploy-project");
      expect(harness.output()).not.toContain("/internal-project");
      expect(generalOutput).toContain("esc to cancel");
    } finally {
      harness.dispose();
    }
  });
});
