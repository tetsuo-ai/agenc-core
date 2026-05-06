import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test, vi } from "vitest";

import type { Tool } from "../../tools/Tool.js";
import {
  __permissionRequestTest,
  type ToolUseConfirm,
} from "../components/permissions/PermissionRequest.js";

const permissionMocks = vi.hoisted(() => {
  const tool = (name: string) => ({ userFacingName: () => name });
  const component = () => function MockPermissionComponent() {
    return null;
  };
  return {
    AskUserQuestionTool: tool("AskUserQuestion"),
    BashTool: tool("Bash"),
    EnterPlanModeTool: tool(""),
    ExitPlanModeV2Tool: tool(""),
    FileEditTool: tool("Edit"),
    FileReadTool: tool("Read"),
    FileWriteTool: tool("Write"),
    GlobTool: tool("Glob"),
    GrepTool: tool("Grep"),
    NotebookEditTool: tool("NotebookEdit"),
    PowerShellTool: tool("PowerShell"),
    SkillTool: tool("Skill"),
    WebFetchTool: tool("WebFetch"),
    AskUserQuestionPermissionRequest: component(),
    BashPermissionRequest: component(),
    EnterPlanModePermissionRequest: component(),
    ExitPlanModePermissionRequest: component(),
    FallbackPermissionRequest: component(),
    FileEditPermissionRequest: component(),
    FilesystemPermissionRequest: component(),
    FileWritePermissionRequest: component(),
    NotebookEditPermissionRequest: component(),
    PowerShellPermissionRequest: component(),
    SkillPermissionRequest: component(),
    WebFetchPermissionRequest: component(),
  };
});

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../../agenc/upstream/hooks/useNotifyAfterTimeout.js", () => ({
  useNotifyAfterTimeout: () => {},
}));
vi.mock("../keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
}));
vi.mock("../../tools/ask-user-question/tui-tool.js", () => ({
  AskUserQuestionTool: permissionMocks.AskUserQuestionTool,
}));
vi.mock("../../tools/BashTool/BashTool.js", () => ({
  BashTool: permissionMocks.BashTool,
}));
vi.mock("../../tools/EnterPlanModeTool/EnterPlanModeTool.js", () => ({
  EnterPlanModeTool: permissionMocks.EnterPlanModeTool,
}));
vi.mock("../../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js", () => ({
  ExitPlanModeV2Tool: permissionMocks.ExitPlanModeV2Tool,
}));
vi.mock("../../tools/FileEditTool/FileEditTool.js", () => ({
  FileEditTool: permissionMocks.FileEditTool,
}));
vi.mock("../../tools/FileReadTool/FileReadTool.js", () => ({
  FileReadTool: permissionMocks.FileReadTool,
}));
vi.mock("../../tools/FileWriteTool/FileWriteTool.js", () => ({
  FileWriteTool: permissionMocks.FileWriteTool,
}));
vi.mock("../../tools/GlobTool/GlobTool.js", () => ({
  GlobTool: permissionMocks.GlobTool,
}));
vi.mock("../../tools/GrepTool/GrepTool.js", () => ({
  GrepTool: permissionMocks.GrepTool,
}));
vi.mock("../../tools/NotebookEditTool/NotebookEditTool.js", () => ({
  NotebookEditTool: permissionMocks.NotebookEditTool,
}));
vi.mock("../../tools/PowerShellTool/PowerShellTool.js", () => ({
  PowerShellTool: permissionMocks.PowerShellTool,
}));
vi.mock("../../tools/SkillTool/SkillTool.js", () => ({
  SkillTool: permissionMocks.SkillTool,
}));
vi.mock("../../tools/WebFetchTool/WebFetchTool.js", () => ({
  WebFetchTool: permissionMocks.WebFetchTool,
}));
vi.mock(
  "../../agenc/upstream/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.js",
  () => ({
    AskUserQuestionPermissionRequest:
      permissionMocks.AskUserQuestionPermissionRequest,
  }),
);
vi.mock(
  "../../agenc/upstream/components/permissions/BashPermissionRequest/BashPermissionRequest.js",
  () => ({
    BashPermissionRequest: permissionMocks.BashPermissionRequest,
  }),
);
vi.mock(
  "../../agenc/upstream/components/permissions/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.js",
  () => ({
    EnterPlanModePermissionRequest: permissionMocks.EnterPlanModePermissionRequest,
  }),
);
vi.mock(
  "../../agenc/upstream/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js",
  () => ({
    ExitPlanModePermissionRequest: permissionMocks.ExitPlanModePermissionRequest,
  }),
);
vi.mock("../../agenc/upstream/components/permissions/FallbackPermissionRequest.js", () => ({
  FallbackPermissionRequest: permissionMocks.FallbackPermissionRequest,
}));
vi.mock(
  "../../agenc/upstream/components/permissions/FileEditPermissionRequest/FileEditPermissionRequest.js",
  () => ({
    FileEditPermissionRequest: permissionMocks.FileEditPermissionRequest,
  }),
);
vi.mock(
  "../../agenc/upstream/components/permissions/FilesystemPermissionRequest/FilesystemPermissionRequest.js",
  () => ({
    FilesystemPermissionRequest: permissionMocks.FilesystemPermissionRequest,
  }),
);
vi.mock(
  "../../agenc/upstream/components/permissions/FileWritePermissionRequest/FileWritePermissionRequest.js",
  () => ({
    FileWritePermissionRequest: permissionMocks.FileWritePermissionRequest,
  }),
);
vi.mock(
  "../../agenc/upstream/components/permissions/NotebookEditPermissionRequest/NotebookEditPermissionRequest.js",
  () => ({
    NotebookEditPermissionRequest: permissionMocks.NotebookEditPermissionRequest,
  }),
);
vi.mock(
  "../../agenc/upstream/components/permissions/PowerShellPermissionRequest/PowerShellPermissionRequest.js",
  () => ({
    PowerShellPermissionRequest: permissionMocks.PowerShellPermissionRequest,
  }),
);
vi.mock(
  "../../agenc/upstream/components/permissions/SkillPermissionRequest/SkillPermissionRequest.js",
  () => ({
    SkillPermissionRequest: permissionMocks.SkillPermissionRequest,
  }),
);
vi.mock(
  "../../agenc/upstream/components/permissions/WebFetchPermissionRequest/WebFetchPermissionRequest.js",
  () => ({
    WebFetchPermissionRequest: permissionMocks.WebFetchPermissionRequest,
  }),
);

const runtimeRoot = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

function readRuntime(path: string): string {
  return readFileSync(resolve(runtimeRoot, path), "utf8");
}

function toolUseConfirmFor(tool: Tool, input: Record<string, unknown> = {}): ToolUseConfirm {
  return {
    tool,
    input,
  } as unknown as ToolUseConfirm;
}

describe("PermissionRequest absorb wiring", () => {
  test("routes the live overlay through the absorbed TUI component", () => {
    const permissionRequests = readRuntime(
      ["src", "tui", "permission-requests.tsx"].join("/"),
    );

    expect(permissionRequests).toContain(
      './components/permissions/PermissionRequest.js',
    );
    expect(permissionRequests).not.toContain(
      "../../agenc/upstream/components/permissions/" +
        "PermissionRequest.js",
    );
  });

  test("removes the upstream PermissionRequest entrypoint", () => {
    expect(
      existsSync(
        resolve(
          runtimeRoot,
          "src/agenc/upstream/components/permissions",
          "PermissionRequest.tsx",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        resolve(runtimeRoot, "src/tui/components/permissions/PermissionRequest.tsx"),
      ),
    ).toBe(true);
  });

  test("dispatches normal tool permissions to their expected UI", () => {
    expect(__permissionRequestTest.permissionComponentForTool(
      permissionMocks.BashTool as unknown as Tool,
    )).toBe(
      permissionMocks.BashPermissionRequest,
    );
    expect(__permissionRequestTest.permissionComponentForTool(
      permissionMocks.FileReadTool as unknown as Tool,
    )).toBe(
      permissionMocks.FilesystemPermissionRequest,
    );
    expect(
      __permissionRequestTest.permissionComponentForTool({
        userFacingName: () => "CustomTool",
      } as unknown as Tool),
    ).toBe(permissionMocks.FallbackPermissionRequest);
  });

  test("keeps notification copy behavior after the move", () => {
    expect(
      __permissionRequestTest.getNotificationMessage(
        toolUseConfirmFor(permissionMocks.ExitPlanModeV2Tool as unknown as Tool),
      ),
    ).toBe("AgenC needs your approval for the plan");
    expect(
      __permissionRequestTest.getNotificationMessage(
        toolUseConfirmFor(permissionMocks.EnterPlanModeTool as unknown as Tool),
      ),
    ).toBe("AgenC wants to enter plan mode");
    expect(
      __permissionRequestTest.getNotificationMessage(
        toolUseConfirmFor({
          userFacingName: () => "CustomTool",
        } as unknown as Tool),
      ),
    ).toBe("AgenC needs your permission to use CustomTool");
    expect(
      __permissionRequestTest.getNotificationMessage(
        toolUseConfirmFor({
          userFacingName: () => "",
        } as unknown as Tool),
      ),
    ).toBe("AgenC needs your attention");
  });

  test("makes unported optional permission features unreachable", () => {
    expect(__permissionRequestTest.unsupportedFeatureState()).toEqual({
      reviewArtifactTool: null,
      reviewArtifactPermissionRequest: null,
      workflowTool: null,
      workflowPermissionRequest: null,
    });
  });
});
