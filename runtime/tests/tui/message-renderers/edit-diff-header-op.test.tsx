import React from "react";
import { describe, expect, it } from "vitest";

import { Box } from "../../../src/tui/ink.js";
import { renderEditDiffPreview } from "../../../src/tui/message-renderers/AssistantToolUseMessage.js";
import { renderToString } from "../../../src/utils/staticRender.js";

// UX fix: the first-create diff and an edit diff used to render an identical
// "DIFF <file>" header, so a user could not tell "created a new file" from
// "edited an existing one". The header now distinguishes the operation:
//   - Write (a first write / all-additions, old content empty) → CREATE
//   - Edit / MultiEdit (a change to existing content)          → EDIT

function render(node: React.ReactNode): Promise<string> {
  return renderToString(
    <Box flexDirection="column">{node}</Box>,
    { columns: 100, rows: 24 },
  );
}

describe("edit diff header operation label", () => {
  it("a Write (new file) header says CREATE, not EDIT", async () => {
    const node = renderEditDiffPreview("Write", {
      file_path: "src/new-thing.ts",
      content: "export const x = 1\nexport const y = 2\n",
    });
    expect(node).not.toBeNull();
    const out = await render(node);
    expect(out).toContain("CREATE");
    expect(out).toContain("new-thing.ts");
    // It is a first write — all additions, nothing removed.
    expect(out).toContain("+2 -0");
    // The old neutral/edit label is NOT used for a create.
    expect(out).not.toContain("EDIT");
  });

  it("an Edit (existing file) header says EDIT, not CREATE", async () => {
    const node = renderEditDiffPreview("Edit", {
      file_path: "src/existing.ts",
      old_string: "const a = 1\n",
      new_string: "const a = 2\n",
    });
    expect(node).not.toBeNull();
    const out = await render(node);
    expect(out).toContain("EDIT");
    expect(out).toContain("existing.ts");
    expect(out).not.toContain("CREATE");
  });

  it("a MultiEdit header says EDIT (an edit, not a create)", async () => {
    const node = renderEditDiffPreview("MultiEdit", {
      file_path: "src/multi.ts",
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "beta", new_string: "BETA" },
      ],
    });
    expect(node).not.toBeNull();
    const out = await render(node);
    expect(out).toContain("EDIT");
    expect(out).not.toContain("CREATE");
  });

  it("REVERT-SENSITIVITY: Write→CREATE and Edit→EDIT are distinct headers", async () => {
    // The crux of the bug: the two operations must NOT share one header label.
    const createOut = await render(
      renderEditDiffPreview("Write", {
        file_path: "src/a.ts",
        content: "line one\nline two\n",
      }),
    );
    const editOut = await render(
      renderEditDiffPreview("Edit", {
        file_path: "src/a.ts",
        old_string: "line one\n",
        new_string: "line ONE\n",
      }),
    );
    // Distinct verbs — a revert to the hard-coded shared "DIFF" header would
    // make both contain "DIFF" and neither contain CREATE/EDIT, failing here.
    expect(createOut).toContain("CREATE");
    expect(createOut).not.toContain("EDIT");
    expect(editOut).toContain("EDIT");
    expect(editOut).not.toContain("CREATE");
    // Neither still shows the old undifferentiated "DIFF" header.
    expect(createOut).not.toContain("DIFF");
    expect(editOut).not.toContain("DIFF");
  });
});
