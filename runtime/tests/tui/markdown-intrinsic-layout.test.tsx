import React from "react";
import { describe, expect, it } from "vitest";
import { Box } from "../../src/tui/ink.js";
import { Markdown, StreamingMarkdown } from "../../src/tui/components/markdown/Markdown.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import { renderToString } from "../../src/utils/staticRender.js";

const DOCUMENT = `# Intrinsic document

This paragraph must remain before the table. Its long descriptive words wrap across narrow terminals without table cells replacing the text. **Bold text** and plain text share these rows.

## Files

- task.js contains the command implementation
- task.test.js contains independent regression tests

| Command | Arguments | Behavior |
| --- | --- | --- |
| add | one or more words | Append a task and print the assigned ID |
| list | no arguments | Display stored tasks and their completion status |
| done | integer ID | Mark the matching task as completed |

## Verification

Run the test suite and inspect the resulting JSON file.
`;

async function renderDocument(columns: number, height: number | undefined, streaming: boolean): Promise<string[]> {
  const initialState = getDefaultAppState();
  const Content = streaming ? StreamingMarkdown : Markdown;
  const output = await renderToString(
    <AppStateProvider initialState={{ ...initialState, settings: { ...initialState.settings, syntaxHighlightingDisabled: true } }}>
      <Box flexDirection="column" maxHeight={height} overflow="hidden">
        <Content>{DOCUMENT}</Content>
      </Box>
    </AppStateProvider>,
    { columns, rows: 80 },
  );
  return output.trimEnd().split("\n");
}

describe("bounded Markdown document flow", () => {
  it.each([40, 80, 140])("clips intrinsic rows without squeezing blocks at %i columns", async columns => {
    for (const streaming of [false, true]) {
      const full = await renderDocument(columns, undefined, streaming);
      for (const height of [6, 14, 22]) {
        const bounded = await renderDocument(columns, height, streaming);
        expect(bounded).toEqual(full.slice(0, height).join("\n").trimEnd().split("\n"));
      }
    }
  });
});
