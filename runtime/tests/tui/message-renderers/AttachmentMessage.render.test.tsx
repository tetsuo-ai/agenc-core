import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { renderToString } from "../../utils/staticRender.js";
import { AttachmentMessage } from "./AttachmentMessage.js";

const swarmsMock = vi.hoisted(() => ({
  enabled: false,
}));

const appStateMock = vi.hoisted(() => ({
  tasks: {} as Record<string, unknown>,
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("../../utils/agentSwarmsEnabled.js", () => ({
  isAgentSwarmsEnabled: () => swarmsMock.enabled,
}));

vi.mock("../../utils/teammateMailbox.js", () => ({
  isShutdownApproved: (text: string) => text === "shutdown-approved",
}));

vi.mock("../state/AppState.js", () => ({
  useAppState: (selector: (state: typeof appStateMock) => unknown) =>
    selector(appStateMock),
}));

vi.mock("../components/messageActions", () => ({
  useSelectedMessageBg: () => undefined,
}));

vi.mock("../components/MessageResponse", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  return {
    MessageResponse: ({ children }: { children: React.ReactNode }) =>
      ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

vi.mock("../components/design-system/FullWidthRow", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  return {
    default: ({ children }: { children: React.ReactNode }) =>
      ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

vi.mock("../components/FilePathLink", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  return {
    FilePathLink: ({
      children,
      filePath,
    }: {
      children: React.ReactNode;
      filePath: string;
    }) => ReactActual.createElement("ink-text", null, `${children}:${filePath}`),
  };
});

vi.mock("./UserTextMessage", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  return {
    UserTextMessage: ({ param }: { param: { text: string } }) =>
      ReactActual.createElement("ink-text", null, `queued ${param.text}`),
  };
});

vi.mock("../components/v2/messagePrimitives.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  return {
    UserImageMessage: ({ imageId }: { imageId: number }) =>
      ReactActual.createElement("ink-text", null, `image ${imageId}`),
  };
});

vi.mock("../components/DiagnosticsDisplay", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  return {
    DiagnosticsDisplay: () =>
      ReactActual.createElement("ink-text", null, "diagnostics shown"),
  };
});

vi.mock("./PlanApprovalMessage", () => ({
  formatTeammateMessageContent: (text: string) => `formatted ${text}`,
  tryRenderPlanApprovalMessage: () => null,
}));

vi.mock("./UserTeammateMessage", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  return {
    TeammateMessageContent: ({
      content,
      displayName,
      summary,
    }: {
      content: string;
      displayName: string;
      summary?: string;
    }) =>
      ReactActual.createElement(
        "ink-text",
        null,
        `${displayName}: ${content}${summary ? ` (${summary})` : ""}`,
      ),
  };
});

async function renderAttachment(
  attachment: unknown,
  options: {
    addMargin?: boolean;
    isTranscriptMode?: boolean;
    verbose?: boolean;
  } = {},
): Promise<string> {
  return renderToString(
    <AttachmentMessage
      addMargin={options.addMargin ?? false}
      attachment={attachment as never}
      isTranscriptMode={options.isTranscriptMode}
      verbose={options.verbose ?? false}
    />,
    { columns: 120 },
  );
}

describe("AttachmentMessage rendering", () => {
  beforeEach(() => {
    swarmsMock.enabled = false;
    appStateMock.tasks = {};
  });

  test("renders common file, memory, skill, and command attachment summaries", async () => {
    const cases: Array<[unknown, string]> = [
      [
        {
          displayPath: "src",
          type: "directory",
        },
        "Listed directory src",
      ],
      [
        {
          content: {
            file: { numLines: 12 },
            type: "text",
          },
          displayPath: "src/app.ts",
          truncated: true,
          type: "file",
        },
        "Read src/app.ts (12+ lines)",
      ],
      [
        {
          content: {
            file: { cells: [1, 2, 3] },
            type: "notebook",
          },
          displayPath: "analysis.ipynb",
          type: "already_read_file",
        },
        "Read analysis.ipynb (3 cells)",
      ],
      [
        {
          content: { type: "file_unchanged" },
          displayPath: "stable.txt",
          type: "file",
        },
        "Read stable.txt (unchanged)",
      ],
      [
        {
          displayPath: "src/ref.ts",
          type: "compact_file_reference",
        },
        "Referenced file src/ref.ts",
      ],
      [
        {
          displayPath: "guide.pdf",
          pageCount: 8,
          type: "pdf_reference",
        },
        "Referenced PDF guide.pdf (8 pages)",
      ],
      [
        {
          displayPath: "src/file.ts",
          ideName: "VS Code",
          lineEnd: 14,
          lineStart: 10,
          type: "selected_lines_in_ide",
        },
        "Selected 5 lines from src/file.ts in VS Code",
      ],
      [
        {
          displayPath: "AGENTS.md",
          type: "nested_memory",
        },
        "Loaded AGENTS.md",
      ],
      [
        {
          displayPath: ".agenc/skills",
          skillNames: ["planner", "fixer"],
          type: "dynamic_skill",
        },
        "Loaded 2 skills from .agenc/skills",
      ],
      [
        {
          isInitial: false,
          skillCount: 4,
          type: "skill_listing",
        },
        "4 skills available",
      ],
      [
        {
          addedTypes: ["reviewer", "tester"],
          isInitial: false,
          type: "agent_listing_delta",
        },
        "2 agent types available",
      ],
      [
        {
          planFilePath: "/tmp/plan.md",
          type: "plan_file_reference",
        },
        "Plan file referenced",
      ],
      [
        {
          skills: [{ name: "build" }, { name: "test" }],
          type: "invoked_skills",
        },
        "Skills restored (build, test)",
      ],
      [
        {
          name: "README",
          server: "docs",
          type: "mcp_resource",
        },
        "Read MCP resource README from docs",
      ],
      [
        {
          type: "diagnostics",
        },
        "diagnostics shown",
      ],
      [
        {
          imagePasteIds: [7, 8],
          prompt: "run tests",
          type: "queued_command",
        },
        "queued run tests",
      ],
    ];

    for (const [attachment, expected] of cases) {
      await expect(renderAttachment(attachment)).resolves.toContain(expected);
    }
  });

  test("renders verbose relevant memories and transcript contents", async () => {
    const output = await renderAttachment(
      {
        memories: [
          { content: "memory body", path: "/repo/AGENTS.md" },
          { content: "other body", path: "/repo/NOTES.md" },
        ],
        type: "relevant_memories",
      },
      { isTranscriptMode: true, verbose: true },
    );

    expect(output).toContain("Recalled 2 memories");
    expect(output).toContain("AGENTS.md:/repo/AGENTS.md");
    expect(output).toContain("memory body");
  });

  test("renders hook and task status attachment branches", async () => {
    const cases: Array<[unknown, string, boolean?]> = [
      [
        {
          hookEvent: "PostToolUse",
          type: "async_hook_response",
        },
        "Async hook PostToolUse completed",
        true,
      ],
      [
        {
          blockingError: { blockingError: "blocked because no" },
          hookEvent: "PreToolUse",
          hookName: "lint",
          type: "hook_blocking_error",
        },
        "lint hook returned blocking error",
      ],
      [
        {
          hookEvent: "PreToolUse",
          hookName: "lint",
          type: "hook_non_blocking_error",
        },
        "lint hook error",
      ],
      [
        {
          hookEvent: "PreToolUse",
          hookName: "lint",
          type: "hook_error_during_execution",
        },
        "lint hook warning",
      ],
      [
        {
          hookEvent: "PreToolUse",
          hookName: "lint",
          message: "please continue",
          type: "hook_stopped_continuation",
        },
        "lint hook stopped continuation: please continue",
      ],
      [
        {
          content: "hello",
          hookName: "status",
          type: "hook_system_message",
        },
        "status says: hello",
      ],
      [
        {
          decision: "deny",
          hookEvent: "PermissionRequest",
          type: "hook_permission_decision",
        },
        "Denied by PermissionRequest hook",
      ],
      [
        {
          description: "long-running job",
          status: "running",
          taskType: "local_agent",
          type: "task_status",
        },
        'Task "long-running job" still running in background',
      ],
      [
        {
          count: 2,
          type: "teammate_shutdown_batch",
        },
        "2 teammates shut down gracefully",
      ],
    ];

    for (const [attachment, expected, verbose] of cases) {
      await expect(renderAttachment(attachment, { verbose })).resolves.toContain(
        expected,
      );
    }
  });

  test("renders teammate mailbox and in-process teammate task statuses", async () => {
    swarmsMock.enabled = true;
    appStateMock.tasks = {
      teammate: {
        identity: {
          agentName: "Fixer",
          color: "purple",
        },
        type: "in_process_teammate",
      },
    };

    const mailbox = await renderAttachment({
      messages: [
        { from: "system", text: "shutdown-approved" },
        { from: "system", text: '{"type":"idle_notification"}' },
        {
          color: "cyan",
          from: "Planner",
          summary: "short",
          text: "hello",
        },
        {
          from: "Lead",
          text: JSON.stringify({
            assignedBy: "Lead",
            subject: "Fix tests",
            taskId: "T-1",
            type: "task_assignment",
          }),
        },
      ],
      type: "teammate_mailbox",
    });

    expect(mailbox).toContain("Planner: formatted hello (short)");
    expect(mailbox).toContain("Task assigned: #T-1 - Fix tests");

    const status = await renderAttachment({
      description: "fix",
      status: "completed",
      taskId: "teammate",
      taskType: "in_process_teammate",
      type: "task_status",
    });

    expect(status).toContain("Teammate @Fixer shut down gracefully");
  });

  test("keeps intentionally hidden attachments silent", async () => {
    const cases = [
      { isInitial: true, skillCount: 2, type: "skill_listing" },
      { addedTypes: [], isInitial: false, type: "agent_listing_delta" },
      { hookEvent: "SessionStart", type: "async_hook_response" },
      { hookEvent: "Stop", hookName: "stop", type: "hook_non_blocking_error" },
      { hookEvent: "Stop", hookName: "stop", type: "hook_error_during_execution" },
      { hookEvent: "Stop", hookName: "stop", message: "x", type: "hook_stopped_continuation" },
      { type: "command_permissions" },
      { type: "hook_success" },
      { skills: [], type: "invoked_skills" },
    ];

    for (const attachment of cases) {
      const output = await renderAttachment(attachment);
      expect(output.trim()).toBe("");
    }
  });
});
