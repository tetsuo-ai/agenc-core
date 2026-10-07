import { describe, expect, test, vi } from "vitest";

const feature = vi.hoisted(() => vi.fn(() => false));

vi.mock("bun:bundle", () => ({ feature }));

import type { PermissionDecisionReason } from "../../../src/types/permissions.js";
import { BASH_TOOL_NAME } from "../../../src/tools/BashTool/toolName.js";
import { createPermissionRequestMessage } from "../../../src/utils/permissions/permissions.js";

function ask(): { behavior: "ask"; message: string } {
  return { behavior: "ask", message: "ask" };
}

describe("createPermissionRequestMessage", () => {
  test("uses the generic grant prompt without a decision reason", () => {
    expect(createPermissionRequestMessage("Write")).toBe(
      "AgenC requested permissions to use Write, but you haven't granted it yet.",
    );
  });

  test("names hook, rule, mode, and tool-prompt reasons", () => {
    expect(
      createPermissionRequestMessage("Write", {
        type: "hook",
        hookName: "PreToolUse",
      }),
    ).toBe("Hook 'PreToolUse' requires approval for this Write command");
    expect(
      createPermissionRequestMessage("Write", {
        type: "hook",
        hookName: "PreToolUse",
        reason: "untrusted path",
      }),
    ).toBe("Hook 'PreToolUse' blocked this action: untrusted path");
    expect(
      createPermissionRequestMessage("Write", {
        type: "rule",
        rule: {
          source: "userSettings",
          ruleBehavior: "ask",
          ruleValue: { toolName: "Write", ruleContent: "src/**" },
        },
      }),
    ).toBe(
      "Permission rule 'Write(src/**)' from user settings requires approval for this Write command",
    );
    expect(
      createPermissionRequestMessage("Write", {
        type: "mode",
        mode: "plan",
      }),
    ).toBe(
      "Current permission mode (Plan Mode) requires approval for this Write command",
    );
    expect(
      createPermissionRequestMessage("Write", {
        type: "permissionPromptTool",
        permissionPromptToolName: "AskUser",
        toolResult: null,
      }),
    ).toBe("Tool 'AskUser' requires approval for this Write command");
  });

  test("passthrough reasons keep their supplied text", () => {
    expect(
      createPermissionRequestMessage("Write", {
        type: "sandboxOverride",
        reason: "excludedCommand",
      }),
    ).toBe("Run outside of the sandbox");
    expect(
      createPermissionRequestMessage("Write", {
        type: "workingDir",
        reason: "path leaves the workspace",
      }),
    ).toBe("path leaves the workspace");
    expect(
      createPermissionRequestMessage("Write", {
        type: "safetyCheck",
        reason: "sensitive path",
        classifierApprovable: true,
      }),
    ).toBe("sensitive path");
    expect(
      createPermissionRequestMessage("Write", {
        type: "other",
        reason: "manual review",
      }),
    ).toBe("manual review");
    expect(
      createPermissionRequestMessage("Write", {
        type: "asyncAgent",
        reason: "teammate needs approval",
      }),
    ).toBe("teammate needs approval");
  });

  test("strips bash output redirections from subcommand display and pluralizes", () => {
    const redirected = createPermissionRequestMessage(BASH_TOOL_NAME, {
      type: "subcommandResults",
      reasons: new Map([
        ["echo hi > /tmp/out", ask()],
        ["echo keep", { behavior: "allow", message: "ok" }],
      ]),
    });
    expect(redirected).toBe(
      "This system.bash command contains multiple operations. The following part requires approval: echo hi",
    );
    expect(redirected).not.toContain("/tmp/out");

    const twoAsks = createPermissionRequestMessage(BASH_TOOL_NAME, {
      type: "subcommandResults",
      reasons: new Map([
        ["git status", ask()],
        ["npm test", { behavior: "passthrough", message: "ask later" }],
      ]),
    });
    expect(twoAsks).toBe(
      "This system.bash command contains multiple operations. The following parts require approval: git status, npm test",
    );
  });

  test("does not strip redirections for non-bash tools", () => {
    expect(
      createPermissionRequestMessage("Write", {
        type: "subcommandResults",
        reasons: new Map([["echo hi > /tmp/out", ask()]]),
      }),
    ).toBe(
      "This Write command contains multiple operations. The following part requires approval: echo hi > /tmp/out",
    );
  });

  test("falls back when no subcommand still needs approval", () => {
    expect(
      createPermissionRequestMessage(BASH_TOOL_NAME, {
        type: "subcommandResults",
        reasons: new Map([
          ["echo ok", { behavior: "allow", message: "ok" }],
        ]),
      }),
    ).toBe(
      "This system.bash command contains multiple operations that require approval",
    );
  });

  test("classifier copy is feature-gated", () => {
    const reason: PermissionDecisionReason = {
      type: "classifier",
      classifier: "bash-safety",
      reason: "network write",
    };
    feature.mockReturnValue(false);
    expect(createPermissionRequestMessage(BASH_TOOL_NAME, reason)).toBe(
      "AgenC requested permissions to use system.bash, but you haven't granted it yet.",
    );

    feature.mockImplementation((name: string) => name === "BASH_CLASSIFIER");
    expect(createPermissionRequestMessage(BASH_TOOL_NAME, reason)).toBe(
      "Classifier 'bash-safety' requires approval for this system.bash command: network write",
    );
    feature.mockReturnValue(false);
  });
});
