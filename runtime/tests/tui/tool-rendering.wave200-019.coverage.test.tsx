import { describe, expect, test, vi } from "vitest";

vi.mock("./ink.js", () => {
  function Box(_props: { readonly children?: unknown }) {
    return null;
  }
  function Text(_props: { readonly children?: unknown }) {
    return null;
  }
  return { Box, Text };
});

import { ResultLine } from "./components/v2/primitives.js";
import {
  BashOutputView,
  createTuiTool,
  EditDiffView,
  FileReadView,
  FileWriteView,
  GlobPathsView,
  GrepMatchesView,
  ToolErrorView,
} from "./tool-rendering.js";

describe("TUI tool result rendering dispatch", () => {
  test("routes structured result envelopes to their focused view components", () => {
    const cases = [
      {
        name: "AnyTool",
        content: "<tool-error-name>AnyTool</tool-error-name><tool-error>boom</tool-error>",
        expected: ToolErrorView,
      },
      {
        name: "Bash",
        content: "<bash-stdout>ok</bash-stdout>",
        expected: BashOutputView,
      },
      {
        name: "Edit",
        content: "<edit-diff>@@ -1 +1 @@\n-old\n+new</edit-diff>",
        expected: EditDiffView,
      },
      {
        name: "FileRead",
        content: "<read-content>body</read-content>",
        expected: FileReadView,
      },
      {
        name: "Write",
        content: "<write-summary>Wrote 4 bytes</write-summary>",
        expected: FileWriteView,
      },
      {
        name: "Grep",
        content: "<grep-matches>src/a.ts:1:hit</grep-matches>",
        expected: GrepMatchesView,
      },
      {
        name: "Glob",
        content: "<glob-paths>src/a.ts</glob-paths>",
        expected: GlobPathsView,
      },
    ];

    for (const { name, content, expected } of cases) {
      const node = createTuiTool(name).renderToolResultMessage(content, []);
      expect((node as { readonly type: unknown }).type).toBe(expected);
      expect((node as { readonly props: { readonly content: string } }).props.content)
        .toBe(content);
    }

    // Unrouted tools summarize to one "└" result line in the transcript; a
    // single short line is shown as itself.
    const generic = createTuiTool("OtherTool").renderToolResultMessage(
      "plain output",
      [],
    );
    expect((generic as { readonly type: unknown }).type).toBe(ResultLine);
    expect(
      (generic as { readonly props: { readonly children: string } }).props.children,
    ).toBe("plain output");

    // Verbose (ctrl+o) keeps the full text in the generic Box/Text body.
    const verboseGeneric = createTuiTool("OtherTool").renderToolResultMessage(
      "plain output",
      [],
      { verbose: true },
    );
    expect((verboseGeneric as { readonly type: { readonly name?: string } }).type.name).toBe(
      "Box",
    );
    expect(
      (verboseGeneric as { readonly props: { readonly children: { readonly props: { readonly children: string } } } })
        .props.children.props.children,
    ).toBe("plain output");
  });
});
