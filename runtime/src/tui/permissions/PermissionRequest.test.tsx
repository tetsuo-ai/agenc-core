import { describe, expect, test } from "vitest";

import {
  isSupportedPermissionSurface,
  permissionComponentForTool,
  permissionSurfaceForTool,
} from "./PermissionRequest.js";
import { PermissionRequestBash } from "./PermissionRequestBash.js";
import { PermissionRequestFile } from "./PermissionRequestFile.js";
import { PermissionRequestSkill } from "./PermissionRequestSkill.js";
import { PermissionRequestWebFetch } from "./PermissionRequestWebFetch.js";

describe("PermissionRequest routing", () => {
  test.each([
    ["Bash", "shell"],
    ["system.bash", "shell"],
    ["PowerShell", "shell"],
    ["exec_command", "shell"],
    ["local_shell", "shell"],
    ["Edit", "file"],
    ["edit_file", "file"],
    ["Write", "file"],
    ["write_file", "file"],
    ["WebFetch", "web"],
    ["WebSearch", "web"],
    ["Skill", "skill"],
    ["AskUserQuestion", "ask-user-question"],
    ["ExitPlanMode", "exit-plan"],
  ] as const)("maps %s to the %s permission surface", (toolName, surface) => {
    expect(permissionSurfaceForTool(toolName)).toBe(surface);
    expect(isSupportedPermissionSurface(toolName)).toBe(true);
  });

  test.each([
    ["Bash", PermissionRequestBash],
    ["system.bash", PermissionRequestBash],
    ["PowerShell", PermissionRequestBash],
    ["exec_command", PermissionRequestBash],
    ["local_shell", PermissionRequestBash],
    ["Edit", PermissionRequestFile],
    ["edit_file", PermissionRequestFile],
    ["Write", PermissionRequestFile],
    ["write_file", PermissionRequestFile],
    ["WebFetch", PermissionRequestWebFetch],
    ["WebSearch", PermissionRequestWebFetch],
    ["Skill", PermissionRequestSkill],
  ] as const)(
    "routes %s to its OpenClaude-style dialog body",
    (toolName, body) => {
      expect(permissionComponentForTool(toolName)).toBe(body);
    },
  );

  test.each(["AskUserQuestion", "ExitPlanMode"] as const)(
    "hides %s from the generic PermissionRequest body router",
    (toolName) => {
      expect(permissionComponentForTool(toolName)).toBeNull();
    },
  );

  test.each([
    "NotebookEdit",
    "Monitor",
    "Workflow",
    "ReviewArtifact",
    "ComputerUse",
    "EnterPlanMode",
    "system.delete",
    "ListMcpResourcesTool",
  ])("does not expose unsupported permission surface %s", (toolName) => {
    expect(permissionSurfaceForTool(toolName)).toBeNull();
    expect(permissionComponentForTool(toolName)).toBeNull();
    expect(isSupportedPermissionSurface(toolName)).toBe(false);
  });
});
