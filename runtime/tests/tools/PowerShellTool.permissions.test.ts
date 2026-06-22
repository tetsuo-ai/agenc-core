import { beforeEach, describe, expect, test, vi } from "vitest";

import { applyPermissionUpdate } from "../../src/permissions/rules.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../../src/permissions/types.js";
import type { ToolUseContext } from "../../src/tools/Tool.js";
import { powershellToolHasPermission } from "../../src/tools/PowerShellTool/powershellPermissions.js";
import {
  parsePowerShellCommand,
  type ParsedPowerShellCommand,
} from "../../src/utils/powershell/parser.js";

vi.mock("../../src/utils/powershell/parser.js", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../src/utils/powershell/parser.js")>();
  return {
    ...actual,
    parsePowerShellCommand: vi.fn(),
  };
});

const parsePowerShellCommandMock = vi.mocked(parsePowerShellCommand);

function invalidParsedCommand(command: string): ParsedPowerShellCommand {
  return {
    valid: false,
    errors: [
      {
        message: "PowerShell parser unavailable",
        errorId: "NoPowerShell",
      },
    ],
    statements: [],
    variables: [],
    hasStopParsing: false,
    originalCommand: command,
  };
}

function toolUseContext(
  toolPermissionContext: ToolPermissionContext,
): ToolUseContext {
  return {
    getAppState: () => ({ toolPermissionContext }),
  } as unknown as ToolUseContext;
}

describe("PowerShell parse-failed permission fallback", () => {
  beforeEach(() => {
    parsePowerShellCommandMock.mockImplementation(async command =>
      invalidParsedCommand(command),
    );
  });

  test("normalizes assignment prefixes before applying sub-command deny rules", async () => {
    const command = "$x = Invoke-Expression 'evil'";
    const permissionContext = applyPermissionUpdate(
      createEmptyToolPermissionContext(),
      {
        type: "addRules",
        destination: "session",
        behavior: "deny",
        rules: [
          {
            toolName: "PowerShell",
            ruleContent: "Invoke-Expression:*",
          },
        ],
      },
    );

    const result = await powershellToolHasPermission(
      { command },
      toolUseContext(permissionContext),
    );

    expect(parsePowerShellCommandMock).toHaveBeenCalledWith(command);
    expect(result.behavior).toBe("deny");
    expect(result.decisionReason).toMatchObject({ type: "rule" });
  });

  test("denies dangerous Remove-Item paths when parsing is unavailable", async () => {
    const command = "Remove-Item / -Recurse -Force";

    const result = await powershellToolHasPermission(
      { command },
      toolUseContext(createEmptyToolPermissionContext()),
    );

    expect(result.behavior).toBe("deny");
    expect(result.message).toContain(
      "Remove-Item on system path '/' is blocked",
    );
    expect(result.decisionReason).toEqual({
      type: "other",
      reason: "Removal targets a protected system path",
    });
  });
});
