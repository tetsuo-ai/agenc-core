import { PassThrough } from "node:stream";
import type { StructuredPatchHunk } from "diff";
import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, test } from "vitest";

import { createRoot } from "../../../ink/root.js";
import {
  calculateWordDiffs,
  numberDiffLines,
  processAdjacentLines,
  StructuredDiffFallback,
  transformLinesToObjects,
  type LineObject,
} from "./Fallback.js";

async function renderToText(node: React.ReactNode): Promise<string> {
  let output = "";
  const stdout = new PassThrough();
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number }).columns = 100;

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  try {
    root.render(node);
    await new Promise(resolve => setTimeout(resolve, 30));
    return stripAnsi(output);
  } finally {
    root.unmount();
    stdin.end();
  }
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("StructuredDiffFallback helpers", () => {
  test("transforms diff lines into typed line objects", () => {
    expect(transformLinesToObjects(["+added", "-removed", " unchanged"])).toEqual([
      { code: "added", i: 0, originalCode: "added", type: "add" },
      { code: "removed", i: 0, originalCode: "removed", type: "remove" },
      { code: "unchanged", i: 0, originalCode: "unchanged", type: "nochange" },
    ]);
  });

  test("pairs adjacent remove/add lines for word diffs and preserves unmatched lines", () => {
    const lines = transformLinesToObjects([
      "-const oldName = value.old",
      "-const oldOnly = true",
      "+const newName = value.new",
      " context",
      "-deleteOnly()",
      "+insertOnly()",
      "+extraAdd()",
    ]);

    const processed = processAdjacentLines(lines);

    expect(processed.map(line => line.type)).toEqual([
      "remove",
      "remove",
      "add",
      "nochange",
      "remove",
      "add",
      "add",
    ]);
    expect(processed[0]?.wordDiff).toBe(true);
    expect(processed[0]?.matchedLine).toBe(processed[2]);
    expect(processed[1]?.wordDiff).toBeUndefined();
    expect(processed[4]?.matchedLine).toBe(processed[5]);
    expect(processed[6]?.wordDiff).toBeUndefined();
  });

  test("numbers no-change, add, and remove runs like unified diff rows", () => {
    const diff: LineObject[] = [
      { code: "same", i: 0, originalCode: "same", type: "nochange" },
      { code: "added", i: 0, originalCode: "added", type: "add" },
      { code: "removed-a", i: 0, originalCode: "removed-a", type: "remove" },
      { code: "removed-b", i: 0, originalCode: "removed-b", type: "remove" },
      { code: "same-again", i: 0, originalCode: "same-again", type: "nochange" },
    ];

    expect(numberDiffLines(diff, 10).map(line => [line.type, line.i])).toEqual([
      ["nochange", 10],
      ["add", 11],
      ["remove", 12],
      ["remove", 13],
      ["nochange", 12],
    ]);
  });

  test("calculates word diffs while preserving spaces", () => {
    const parts = calculateWordDiffs("return oldValue + 1", "return newValue + 1");

    expect(parts.map(part => part.value).join("")).toContain("return ");
    expect(parts.some(part => part.removed && part.value === "oldValue")).toBe(true);
    expect(parts.some(part => part.added && part.value === "newValue")).toBe(true);
  });
});

describe("StructuredDiffFallback rendering", () => {
  test("renders word-level add/remove pairs with line numbers", async () => {
    const patch = {
      lines: [
        " function example() {",
        "-  return value.oldName;",
        "+  return value.newName;",
        " }",
      ],
      oldStart: 20,
    } as StructuredPatchHunk;

    const output = compact(
      await renderToText(<StructuredDiffFallback dim={false} patch={patch} width={80} />),
    );

    expect(output).toContain("20 function example()");
    expect(output).toContain("- return value.oldName;");
    expect(output).toContain("+ return value.newName;");
    expect(output).toContain("22 }");
  });

  test("falls back to full-line rendering for dimmed or heavily changed rows", async () => {
    const patch = {
      lines: [
        "-short",
        "+a completely different and much longer replacement line",
        " unchanged context that should wrap when the width is narrow",
      ],
      oldStart: 3,
    } as StructuredPatchHunk;

    const output = compact(
      await renderToText(<StructuredDiffFallback dim patch={patch} width={24} />),
    );

    expect(output).toContain("3 -short");
    expect(output).toContain("3 +a completely");
    expect(output).toContain("4 unchanged");
  });
});
