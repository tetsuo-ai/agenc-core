import { PassThrough } from "node:stream";

import figures from "figures";
import React, { useLayoutEffect, useState } from "react";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/utils/cwd.js", () => ({
  getCwd: () => "/workspace",
}));

import { DiagnosticsDisplay } from "../../../src/tui/components/DiagnosticsDisplay.js";
import { createRoot } from "../../../src/tui/ink/root.js";
import { renderToString } from "../../../src/utils/staticRender.js";

const previousGlyphMode = process.env.AGENC_TUI_GLYPHS;

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type TestStdout = PassThrough & {
  columns: number;
  isTTY: boolean;
  rows: number;
};

function createStreams(): {
  readonly stdin: TestStdin;
  readonly stdout: TestStdout;
} {
  const stdin = new PassThrough() as TestStdin;
  const stdout = new PassThrough() as TestStdout;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};

  stdout.columns = 120;
  stdout.rows = 24;
  stdout.isTTY = true;
  stdout.resume();

  return { stdin, stdout };
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function renderWithRoot(node: React.ReactNode): Promise<string> {
  const { stdin, stdout } = createStreams();
  let output = "";
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  try {
    root.render(node);
    await sleep();
    return stripAnsi(output);
  } finally {
    root.unmount();
    stdin.end();
    stdout.end();
    await sleep();
  }
}

const compactAttachment = {
  type: "diagnostics",
  isNew: true,
  files: [
    {
      uri: "file:///workspace/src/compact.ts",
      diagnostics: [
        {
          severity: "Error",
          range: {
            start: { line: 1, character: 2 },
            end: { line: 1, character: 9 },
          },
          message: "Invalid compact path",
        },
      ],
    },
  ],
} as const;

function RerenderStableCompact({
  onRender,
}: {
  readonly onRender: (count: number) => void;
}) {
  const [count, setCount] = useState(0);

  useLayoutEffect(() => {
    onRender(count);
    if (count === 0) setCount(1);
  }, [count, onRender]);

  return (
    <DiagnosticsDisplay attachment={compactAttachment} verbose={false} />
  );
}

describe("DiagnosticsDisplay coverage swarm 131", () => {
  afterEach(() => {
    if (previousGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS;
    } else {
      process.env.AGENC_TUI_GLYPHS = previousGlyphMode;
    }
  });

  test("renders verbose file and AgenC right-file diagnostics with optional metadata", async () => {
    process.env.AGENC_TUI_GLYPHS = "ascii";

    const output = await renderToString(
      <DiagnosticsDisplay
        attachment={{
          type: "diagnostics",
          isNew: true,
          files: [
            {
              uri: "file:///workspace/src/problem.ts",
              diagnostics: [
                {
                  severity: "Warning",
                  range: {
                    start: { line: 0, character: 1 },
                    end: { line: 0, character: 6 },
                  },
                  message: "Missing semicolon",
                },
              ],
            },
            {
              uri: "_agenc_fs_right:/workspace/src/generated.ts",
              diagnostics: [
                {
                  severity: "Hint",
                  range: {
                    start: { line: 4, character: 0 },
                    end: { line: 4, character: 5 },
                  },
                  message: "Prefer const",
                  code: "hint-1",
                },
                {
                  severity: "Info",
                  range: {
                    start: { line: 7, character: 3 },
                    end: { line: 7, character: 9 },
                  },
                  message: "Inferred any",
                  source: "typescript",
                },
              ],
            },
          ],
        }}
        verbose={true}
      />,
      120,
    );

    expect(output).toContain("|_ src/problem.ts (file://):");
    expect(output).toContain(
      `${figures.warning} [Line 1:2] Missing semicolon`,
    );
    expect(output).toContain("|_ src/generated.ts (agenc_fs_right):");
    expect(output).toContain(`${figures.star} [Line 5:1] Prefer const [hint-1]`);
    expect(output).toContain(
      `${figures.info} [Line 8:4] Inferred any (typescript)`,
    );
    expect(output).not.toContain("_agenc_fs_right:");
  });

  test("renders compact empty and plural summaries", async () => {
    const empty = await renderToString(
      <DiagnosticsDisplay
        attachment={{ type: "diagnostics", isNew: true, files: [] }}
        verbose={false}
      />,
      120,
    );
    const plural = await renderToString(
      <DiagnosticsDisplay
        attachment={{
          type: "diagnostics",
          isNew: true,
          files: [
            {
              uri: "file:///workspace/src/first.ts",
              diagnostics: compactAttachment.files[0].diagnostics,
            },
            {
              uri: "file:///workspace/src/second.ts",
              diagnostics: [
                compactAttachment.files[0].diagnostics[0],
                compactAttachment.files[0].diagnostics[0],
              ],
            },
          ],
        }}
        verbose={false}
      />,
      120,
    );

    expect(empty.trim()).toBe("");
    expect(plural).toContain("Found 3 new diagnostic issues in 2 files");
    expect(plural).toContain("(ctrl+o to expand)");
  });

  test("reuses compact render branches when stable props rerender", async () => {
    const onRender = vi.fn();

    const output = await renderWithRoot(
      <RerenderStableCompact onRender={onRender} />,
    );

    expect(onRender).toHaveBeenCalledWith(0);
    expect(onRender).toHaveBeenCalledWith(1);
    expect(output.replace(/\s+/g, "")).toContain(
      "Found1newdiagnosticissuein1file",
    );
  });
});
