import { describe, expect, test } from "vitest";

import { validatePermissionsConfig } from "../../src/config/schema.js";
import {
  matchRule,
  toolNamesInPermissionRiskFamily,
} from "../../src/permissions/rules.js";
import { AgentTool } from "../../src/tools/AgentTool/AgentTool.js";
import { TaskOutputTool } from "../../src/tools/TaskOutputTool/TaskOutputTool.js";
import { matchesPattern } from "../../src/utils/hooks.js";
import {
  permissionRuleValueFromString,
} from "../../src/utils/permissions/permissionRuleParser.js";
import { isRemovedLiveToolName } from "../../src/permissions/tool-names.js";
import { validatePermissionRule } from "../../src/utils/settings/permissionValidation.js";

const REMOVED_NAMES = [
  "WebFetch",
  "Brief",
  "Read",
  "FileReadTool",
  "FileEdit",
  "FileEditTool",
  "FileWrite",
  "FileWriteTool",
  "system.grep",
  "system.glob",
  "Bash",
  "bash",
  "desktop.bash",
  "shell",
  "Task",
  "KillShell",
  "AgentOutputTool",
  "BashOutputTool",
] as const;

describe("live tool-name authority", () => {
  test.each(REMOVED_NAMES)("permission surfaces reject removed name %s", (name) => {
    expect(isRemovedLiveToolName(name)).toBe(true);
    expect(permissionRuleValueFromString(`${name}(value)`).toolName).toBe(name);
    expect(validatePermissionRule(name)).toMatchObject({ valid: false });
    expect(() => validatePermissionsConfig({ deny: [name] })).toThrow(
      `removed tool name '${name}'`,
    );
  });

  test("canonical lowercase and dotted permission names remain valid", () => {
    expect(validatePermissionRule("exec_command(git status)")).toEqual({
      valid: true,
    });
    expect(validatePermissionRule("system.bash(git status)")).toEqual({
      valid: true,
    });
    expect(validatePermissionsConfig({
      allow: ["FileRead"],
      ask: ["exec_command(git status)"],
      deny: ["system.bash(rm *)"],
    })).toMatchObject({
      allow: ["FileRead"],
      ask: ["exec_command(git status)"],
      deny: ["system.bash(rm *)"],
    });
  });

  test("permission risk families contain only canonical dispatch names", () => {
    expect(toolNamesInPermissionRiskFamily("system.bash")).toEqual(
      expect.arrayContaining(["system.bash", "exec_command", "write_stdin"]),
    );
    expect(toolNamesInPermissionRiskFamily("system.bash")).not.toContain("Bash");
    expect(toolNamesInPermissionRiskFamily("Edit")).not.toContain("FileEdit");
    expect(toolNamesInPermissionRiskFamily("Write")).not.toContain("FileWrite");
    expect(toolNamesInPermissionRiskFamily("FileRead")).toEqual(["FileRead"]);
    expect(toolNamesInPermissionRiskFamily("Grep")).toEqual(["Grep"]);
    expect(toolNamesInPermissionRiskFamily("Glob")).toEqual(["Glob"]);
    expect(toolNamesInPermissionRiskFamily("Bash")).toEqual([]);

    expect(matchRule(
      {
        source: "userSettings",
        ruleBehavior: "deny",
        ruleValue: { toolName: "Bash" },
      },
      { name: "system.bash" },
    )).toBe(false);
  });

  test("hooks and built-in catalogs do not accept retired task names", () => {
    expect(matchesPattern("spawn_agent", "Task")).toBe(false);
    expect(matchesPattern("spawn_agent", "spawn_agent")).toBe(true);
    expect(AgentTool.aliases ?? []).not.toContain("Task");
    expect(TaskOutputTool.aliases ?? []).not.toEqual(
      expect.arrayContaining(["AgentOutputTool", "BashOutputTool"]),
    );
  });

  test.each([
    { agentId: "task-1" },
    { bash_id: "task-1" },
    { task_id: "task-1", wait_up_to: 1 },
  ])("TaskOutput rejects removed input aliases %#", (input) => {
    expect(TaskOutputTool.inputSchema.safeParse(input).success).toBe(false);
  });
});
