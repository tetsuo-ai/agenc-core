import React from "react";
import { describe, expect, it, vi } from "vitest";

// `bun:bundle` feature() resolves to a no-op in tests, and the hooks the call
// row reads are pinned so the render is deterministic (same harness as
// toolRowPreview.render.test.tsx).
vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../../../src/tui/hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: 100, rows: 24 }),
}));
vi.mock("../../../src/utils/classifierApprovalsHook.js", () => ({
  useIsClassifierChecking: () => false,
}));
vi.mock("../../../src/tui/state/AppState.js", () => ({
  useAppState: (selector: (state: { isBriefOnly: boolean }) => unknown) =>
    selector({ isBriefOnly: false }),
  useAppStateMaybeOutsideOfProvider: (
    selector: (state: {
      pendingWorkerRequest: undefined;
      toolPermissionContext: { mode: string };
    }) => unknown,
  ) =>
    selector({
      pendingWorkerRequest: undefined,
      toolPermissionContext: { mode: "default" },
    }),
}));
vi.mock("../../../src/tui/ink.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/tui/ink.js")
  >("../../../src/tui/ink.js");
  return { ...actual, useTheme: () => ["dark"] };
});

import type { AgenCToolUseBlockParam } from "../../../src/types/message.js";
import type { Tools } from "../../../src/tools/Tool.js";
import { Box } from "../../../src/tui/ink.js";
import {
  AssistantToolUseMessage,
  renderEditDiffPreview,
} from "../../../src/tui/message-renderers/AssistantToolUseMessage.js";
import { createTuiTools } from "../../../src/tui/tool-rendering.js";
import { renderToString } from "../../../src/utils/staticRender.js";

// UX fix: the first-create diff and an edit diff used to render an identical
// "DIFF <file>" header, so a user could not tell "created a new file" from
// "edited an existing one". That header then said CREATE or EDIT. In the A2
// transcript the compact diff has no header at all: the verb on the step row
// carries the operation instead.
//   - Write (a first write / all-additions, old content empty) → "● Wrote <file>"
//   - Edit / MultiEdit (a change to existing content)          → "● Edited <file>"
// The result line under the row gives the "+a -b" stats, then the changed
// lines follow.

const tools = createTuiTools(["Write", "Edit", "MultiEdit"]) as unknown as Tools;

/** Render a finished (resolved, successful) edit step as Message.tsx does. */
function renderStep(name: string, input: unknown): Promise<string> {
  const id = `tu_${name}`;
  const param: AgenCToolUseBlockParam = { type: "tool_use", id, name, input };
  return renderToString(
    <AssistantToolUseMessage
      param={param}
      addMargin={false}
      tools={tools}
      commands={[]}
      verbose={false}
      inProgressToolUseIDs={new Set()}
      progressMessagesForMessage={[]}
      shouldAnimate={false}
      shouldShowDot={false}
      lookups={
        {
          resolvedToolUseIDs: new Set([id]),
          erroredToolUseIDs: new Set(),
          inProgressHookCounts: new Map(),
          resolvedHookCounts: new Map(),
        } as never
      }
    />,
    100,
  );
}

function render(node: React.ReactNode): Promise<string> {
  return renderToString(
    <Box flexDirection="column">{node}</Box>,
    { columns: 100, rows: 24 },
  );
}

describe("edit step operation verb", () => {
  it("a Write (new file) step says Wrote, not Edited", async () => {
    const out = await renderStep("Write", {
      file_path: "src/new-thing.ts",
      content: "export const x = 1\nexport const y = 2\n",
    });
    expect(out).toContain("● Wrote src/new-thing.ts");
    // It is a first write: all additions, nothing removed.
    expect(out).toContain("└ +2 -0");
    // The edit verb is NOT used for a create.
    expect(out).not.toContain("Edited");
  });

  it("an Edit (existing file) step says Edited, not Wrote", async () => {
    const out = await renderStep("Edit", {
      file_path: "src/existing.ts",
      old_string: "const a = 1\n",
      new_string: "const a = 2\n",
    });
    expect(out).toContain("● Edited src/existing.ts");
    expect(out).toContain("└ +1 -1");
    expect(out).not.toContain("Wrote");
  });

  it("a MultiEdit step says Edited (an edit, not a create)", async () => {
    const out = await renderStep("MultiEdit", {
      file_path: "src/multi.ts",
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "beta", new_string: "BETA" },
      ],
    });
    expect(out).toContain("● Edited src/multi.ts");
    expect(out).not.toContain("Wrote");
  });

  it("REVERT-SENSITIVITY: Write→Wrote and Edit→Edited are distinct, and the diff has no op header", async () => {
    // The crux of the bug: the two operations must NOT read the same. The
    // verb on the row now carries it, so the compact diff below has no
    // CREATE/EDIT/DIFF header and no frame.
    const createOut = await renderStep("Write", {
      file_path: "src/a.ts",
      content: "line one\nline two\n",
    });
    const editOut = await renderStep("Edit", {
      file_path: "src/a.ts",
      old_string: "line one\n",
      new_string: "line ONE\n",
    });
    expect(createOut).toContain("● Wrote src/a.ts");
    expect(createOut).not.toContain("Edited");
    expect(editOut).toContain("● Edited src/a.ts");
    expect(editOut).not.toContain("Wrote");

    const diffOnly = await render(
      renderEditDiffPreview("Write", {
        file_path: "src/a.ts",
        content: "line one\nline two\n",
      }),
    );
    expect(diffOnly).toContain("line one");
    for (const header of ["CREATE", "EDIT", "DIFF"]) {
      expect(createOut).not.toContain(header);
      expect(editOut).not.toContain(header);
      expect(diffOnly).not.toContain(header);
    }
    expect(diffOnly).not.toMatch(/[┌┐└┘│]/u);
  });

  it("the compact diff shows changed lines only, at most 8, then a full-diff hint", async () => {
    const out = await renderStep("Write", {
      file_path: "src/big.ts",
      content: `${Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")}\n`,
    });
    expect(out).toContain("└ +20 -0");
    expect(out).toContain("line 7");
    expect(out).not.toContain("line 8");
    expect(out).toContain("… +12 more lines · ctrl+w d for full diff");
    // One line-number column per row: the line where it now lives.
    expect(out).toMatch(/^ +1 \+ line 0$/mu);
  });
});
