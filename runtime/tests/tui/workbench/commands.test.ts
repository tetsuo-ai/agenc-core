import { describe, expect, it } from "vitest";

import {
  attachmentPromptMention,
  attachDiffHunkCommand,
  attachFileCommand,
  attachFileRangeCommand,
  materializeAttachmentMentions,
  openBufferCommand,
  openPreviewCommand,
  attachTaskErrorCommand,
  searchMatchAttachment,
} from "../../../src/tui/workbench/commands.js";
import type { WorkbenchCommand } from "../../../src/tui/workbench/types.js";

describe("workbench command helpers", () => {
  it("creates explicit open-buffer commands", () => {
    expect(openBufferCommand("src/app.ts", 9, false)).toEqual({
      type: "openBuffer",
      path: "src/app.ts",
      line: 9,
      focus: false,
    });
  });

  it("normalizes path-backed commands before they update workbench state", () => {
    expect(openBufferCommand("src\\nested\\app.ts", 9, false)).toMatchObject({
      path: "src/nested/app.ts",
    });
    expect(openPreviewCommand("src\\nested\\app.ts", 9, false)).toMatchObject({
      path: "src/nested/app.ts",
    });
    expect(attachFileCommand("src\\nested\\app.ts")).toMatchObject({
      attachment: {
        id: "file:src/nested/app.ts",
        path: "src/nested/app.ts",
        label: "src/nested/app.ts",
      },
    });
    expect(attachFileRangeCommand("src\\nested\\app.ts", 4, 7)).toMatchObject({
      attachment: {
        id: "file-range:src/nested/app.ts:4-7",
        path: "src/nested/app.ts",
        label: "src/nested/app.ts:4-7",
      },
    });
    expect(attachDiffHunkCommand({
      path: "src\\nested\\app.ts",
      line: 9,
      label: "src\\nested\\app.ts diff",
    })).toMatchObject({
      attachment: {
        id: "diff-hunk:src/nested/app.ts:9",
        path: "src/nested/app.ts",
        label: "src/nested/app.ts diff",
      },
    });
    expect(attachTaskErrorCommand({
      taskId: "test-1",
      file: "src\\nested\\app.test.ts",
      line: 12,
      label: "src\\nested\\app.test.ts failure",
    })).toMatchObject({
      attachment: {
        id: "task-error:test-1:src/nested/app.test.ts:12",
        path: "src/nested/app.test.ts",
        label: "src/nested/app.test.ts failure",
      },
    });
    expect(searchMatchAttachment("needle", {
      id: "src\\nested\\app.ts:6:needle",
      file: "src\\nested\\app.ts",
      line: 6,
      text: "needle",
    })).toMatchObject({
      id: "search-result:src/nested/app.ts:6:needle",
      path: "src/nested/app.ts",
      label: "src/nested/app.ts:6",
    });
    expect(attachmentPromptMention({
      id: "file:src\\nested\\app.ts",
      kind: "file",
      label: "src\\nested\\app.ts",
      path: "src\\nested\\app.ts",
    })).toBe("@src/nested/app.ts");
  });

  it("materializes composer attachments as prompt mentions", () => {
    const fileCommand = attachFileCommand("src/app.ts") as Extract<WorkbenchCommand, { type: "attach" }>;
    const rangeCommand = attachFileRangeCommand("src/app.ts", 4, 7) as Extract<WorkbenchCommand, { type: "attach" }>;
    const searchAttachment = searchMatchAttachment("needle", {
      id: "src/app.ts:9:needle",
      file: "src/app.ts",
      line: 9,
      text: "needle",
    });

    expect(
      materializeAttachmentMentions("explain", [
        fileCommand.attachment,
        rangeCommand.attachment,
        searchAttachment,
      ]),
    ).toBe("@src/app.ts @src/app.ts#L4-7 @src/app.ts#L9\n\nexplain");
  });

  it("materializes every path-backed attachment kind through existing file mention syntax", () => {
    expect(attachmentPromptMention({
      id: "diff:src/app.ts:12",
      kind: "diff-hunk",
      label: "src/app.ts:12",
      path: "src/app.ts",
      line: 12,
    })).toBe("@src/app.ts#L12");
    expect(attachmentPromptMention({
      id: "task:test:src/app.test.ts:4",
      kind: "task-error",
      label: "src/app.test.ts:4",
      path: "src/app.test.ts",
      line: 4,
      taskId: "test",
    })).toBe("@src/app.test.ts#L4");
  });

  it("does not duplicate a mention the user already typed", () => {
    const command = attachFileCommand("src/app.ts") as Extract<WorkbenchCommand, { type: "attach" }>;

    expect(materializeAttachmentMentions("@src/app.ts\n\nexplain", [command.attachment]))
      .toBe("@src/app.ts\n\nexplain");
  });

  it("creates shell and test error attachments", () => {
    const command = attachTaskErrorCommand({
      taskId: "test-1",
      file: "tests/app.test.ts",
      line: 42,
      label: "failing test",
    }) as Extract<WorkbenchCommand, { type: "attach" }>;

    expect(command.attachment).toMatchObject({
      id: "task-error:test-1:tests/app.test.ts:42",
      kind: "task-error",
      path: "tests/app.test.ts",
      line: 42,
      taskId: "test-1",
      label: "failing test",
    });
    expect(attachmentPromptMention(command.attachment)).toBe("@tests/app.test.ts#L42");
  });

  it("creates diff hunk attachments", () => {
    const command = attachDiffHunkCommand({
      path: "src/app.ts",
      line: 9,
    }) as Extract<WorkbenchCommand, { type: "attach" }>;

    expect(command.attachment).toMatchObject({
      id: "diff-hunk:src/app.ts:9",
      kind: "diff-hunk",
      path: "src/app.ts",
      line: 9,
    });
    expect(attachmentPromptMention(command.attachment)).toBe("@src/app.ts#L9");
  });
});
