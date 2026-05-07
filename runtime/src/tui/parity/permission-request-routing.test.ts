import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test, vi } from "vitest";

import type { Tool } from "../../tools/Tool.js";
import { buildToolUseConfirm } from "../permission-requests.js";
import {
  createFileEditTool,
  createFileMultiEditTool,
} from "../../tools/system/file-edit.js";
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
    MonitorTool: tool("Monitor"),
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
    MonitorPermissionRequest: component(),
    NotebookEditPermissionRequest: component(),
    PowerShellPermissionRequest: component(),
    SkillPermissionRequest: component(),
    WebFetchPermissionRequest: component(),
  };
});

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../hooks/useNotifyAfterTimeout.js", () => ({
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
vi.mock("../../tools/FileEditTool/FileEditTool", () => ({
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
vi.mock("../../tools/MonitorTool/MonitorTool.js", () => ({
  MonitorTool: permissionMocks.MonitorTool,
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
  "../components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.js",
  () => ({
    AskUserQuestionPermissionRequest:
      permissionMocks.AskUserQuestionPermissionRequest,
  }),
);
vi.mock(
  "../components/permissions/BashPermissionRequest/BashPermissionRequest.js",
  () => ({
    BashPermissionRequest: permissionMocks.BashPermissionRequest,
  }),
);
vi.mock(
  "../components/permissions/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.js",
  () => ({
    EnterPlanModePermissionRequest: permissionMocks.EnterPlanModePermissionRequest,
  }),
);
vi.mock(
  "../components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js",
  () => ({
    ExitPlanModePermissionRequest: permissionMocks.ExitPlanModePermissionRequest,
  }),
);
vi.mock("../components/permissions/FallbackPermissionRequest.js", () => ({
  FallbackPermissionRequest: permissionMocks.FallbackPermissionRequest,
}));
vi.mock(
  "../components/permissions/FileEditPermissionRequest/FileEditPermissionRequest.js",
  () => ({
    FileEditPermissionRequest: permissionMocks.FileEditPermissionRequest,
  }),
);
vi.mock("../components/diff/FileEditToolDiff.js", () => ({
  FileEditToolDiff: function MockFileEditToolDiff() {
    return null;
  },
}));
vi.mock("../components/diff/FileEditToolDiff", () => ({
  FileEditToolDiff: function MockFileEditToolDiff() {
    return null;
  },
}));
vi.mock(
  "../components/permissions/FilePermissionDialog/FilePermissionDialog.js",
  () => ({
    FilePermissionDialog: function MockFilePermissionDialog() {
      return null;
    },
  }),
);
vi.mock(
  "../components/permissions/FilePermissionDialog/FilePermissionDialog",
  () => ({
    FilePermissionDialog: function MockFilePermissionDialog() {
      return null;
    },
  }),
);
vi.mock(
  "../components/permissions/FilesystemPermissionRequest/FilesystemPermissionRequest.js",
  () => ({
    FilesystemPermissionRequest: permissionMocks.FilesystemPermissionRequest,
  }),
);
vi.mock(
  "../components/permissions/FileWritePermissionRequest/FileWritePermissionRequest.js",
  () => ({
    FileWritePermissionRequest: permissionMocks.FileWritePermissionRequest,
  }),
);
vi.mock(
  "../components/permissions/MonitorPermissionRequest/MonitorPermissionRequest.js",
  () => ({
    MonitorPermissionRequest: permissionMocks.MonitorPermissionRequest,
  }),
);
vi.mock(
  "../components/permissions/NotebookEditPermissionRequest/NotebookEditPermissionRequest.js",
  () => ({
    NotebookEditPermissionRequest: permissionMocks.NotebookEditPermissionRequest,
  }),
);
vi.mock(
  "../components/permissions/PowerShellPermissionRequest/PowerShellPermissionRequest.js",
  () => ({
    PowerShellPermissionRequest: permissionMocks.PowerShellPermissionRequest,
  }),
);
vi.mock(
  "../components/permissions/SkillPermissionRequest/SkillPermissionRequest.js",
  () => ({
    SkillPermissionRequest: permissionMocks.SkillPermissionRequest,
  }),
);
vi.mock(
  "../components/permissions/WebFetchPermissionRequest/WebFetchPermissionRequest.js",
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

function pendingRequestFor(toolName: string, input: Record<string, unknown>) {
  return {
    id: `pending-${toolName}`,
    ctx: {
      callId: `call-${toolName}`,
      toolName,
    },
    input,
    description: `Approve ${toolName}`,
    resolve: vi.fn(),
  };
}

describe("PermissionRequest routing", () => {
  test("routes the live overlay through the absorbed TUI component", () => {
    const permissionRequests = readRuntime(
      ["src", "tui", "permission-requests.tsx"].join("/"),
    );

    expect(permissionRequests).toContain(
      './components/permissions/PermissionRequest.js',
    );
    expect(permissionRequests).not.toContain(
      "../components/permissions" +
        "PermissionRequest.js",
    );
  });

  test("removes the upstream PermissionRequest entrypoint", () => {
    const oldPermissionsEntry = ["src", "components", "permissions", "PermissionRequest.tsx"].join("/");
    expect(
      existsSync(
        resolve(
          runtimeRoot,
          oldPermissionsEntry,
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
      permissionMocks.FileEditTool as unknown as Tool,
    )).toBe(
      permissionMocks.FileEditPermissionRequest,
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

  test("routes live registered Edit and MultiEdit approvals to the edit permission UI", () => {
    const editTool = createFileEditTool({ allowedPaths: ["/tmp"] });
    const multiEditTool = createFileMultiEditTool({ allowedPaths: ["/tmp"] });
    const editConfirm = buildToolUseConfirm(
      pendingRequestFor("Edit", {
        file_path: "/tmp/example.txt",
        old_string: "before",
        new_string: "after",
      }) as never,
      [editTool],
    ) as ToolUseConfirm;
    const multiEditConfirm = buildToolUseConfirm(
      pendingRequestFor("MultiEdit", {
        file_path: "/tmp/example.txt",
        edits: [{ old_string: "before", new_string: "after" }],
      }) as never,
      [multiEditTool],
    ) as ToolUseConfirm;

    expect(__permissionRequestTest.permissionComponentForTool(editConfirm.tool)).toBe(
      permissionMocks.FileEditPermissionRequest,
    );
    expect(
      __permissionRequestTest.permissionComponentForTool(multiEditConfirm.tool),
    ).toBe(permissionMocks.FileEditPermissionRequest);
  });

  test("FileEditPermissionRequest has a live MultiEdit parse/render path", () => {
    const source = readRuntime(
      [
        "src",
        "tui",
        "components",
        "permissions",
        "FileEditPermissionRequest",
        "FileEditPermissionRequest.tsx",
      ].join("/"),
    );

    expect(source).toContain("Array.isArray(input.edits)");
    expect(source).toContain("const edits = editsForInput(parsed)");
    expect(source).toContain("<FileEditToolDiff file_path={file_path} edits={edits} />");
    expect(source).toContain('completionType={edits.length > 1 ? "str_replace_multi" : "str_replace_single"}');
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
