import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { checkPathConstraints } from "../../src/tools/PowerShellTool/pathValidation.js";
import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from "../../src/utils/powershell/parser.js";
import { applyPermissionUpdate } from "../permissions/rules.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../permissions/types.js";

function parsedCommand(
  name: string,
  args: readonly string[],
): ParsedPowerShellCommand {
  const commandText = [name, ...args].join(" ");
  const command: ParsedCommandElement = {
    name,
    nameType: "cmdlet",
    elementType: "CommandAst",
    args: [...args],
    text: commandText,
  };

  return {
    valid: true,
    errors: [],
    statements: [
      {
        statementType: "PipelineAst",
        commands: [command],
        redirections: [],
        text: commandText,
      },
    ],
    variables: [],
    hasStopParsing: false,
    originalCommand: commandText,
  };
}

function contextForRoot(
  root: string,
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return createEmptyToolPermissionContext({
    mode: "acceptEdits",
    additionalWorkingDirectories: new Map([
      [root, { path: root, source: "session" }],
    ]),
    ...overrides,
  });
}

describe("PowerShell path validation", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-powershell-path-"));
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  test("allows writes inside an accepted working directory", () => {
    const target = join(root, "allowed.txt");
    const result = checkPathConstraints(
      { command: `Set-Content ${target}` },
      parsedCommand("Set-Content", [target]),
      contextForRoot(root),
    );

    expect(result.behavior).toBe("passthrough");
  });

  test("honors deny rules before working-directory allowance", () => {
    const targetName = "__agenc_powershell_denied_test__.txt";
    const target = join(process.cwd(), targetName);
    const context = applyPermissionUpdate(contextForRoot(root), {
      type: "addRules",
      destination: "session",
      behavior: "deny",
      rules: [{ toolName: "Edit", ruleContent: targetName }],
    });

    const result = checkPathConstraints(
      { command: `Set-Content ${target}` },
      parsedCommand("Set-Content", [target]),
      context,
    );

    expect(result.behavior).toBe("deny");
    expect(result.decisionReason?.type).toBe("rule");
  });
});
