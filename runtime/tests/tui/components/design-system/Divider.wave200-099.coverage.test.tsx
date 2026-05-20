import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test } from "vitest";

import type { DOMElement, DOMNode } from "../../ink/dom.js";
import instances from "../../ink/instances.js";
import { createRoot } from "../../ink/root.js";
import type { TextStyles } from "../../ink/styles.js";
import { Box } from "../../ink.js";
import { getTheme } from "../../../utils/theme.js";
import { Divider } from "./Divider.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type StyledSegment = {
  text: string;
  styles: TextStyles;
};

function createStreams(columns = 16): {
  stdin: TestStdin;
  stdout: PassThrough;
} {
  const stdin = new PassThrough() as TestStdin;
  const stdout = new PassThrough();

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};

  stdout.resume();
  (stdout as unknown as { columns: number }).columns = columns;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  return { stdin, stdout };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream);

  if (!instance?.rootNode) {
    throw new Error("Ink root node not found");
  }

  return instance.rootNode;
}

function collectSegments(
  node: DOMNode,
  inheritedStyles: TextStyles = {},
  segments: StyledSegment[] = [],
): StyledSegment[] {
  if (node.nodeName === "#text") {
    if (node.nodeValue !== "") {
      segments.push({ text: node.nodeValue, styles: inheritedStyles });
    }
    return segments;
  }

  const nextStyles = node.textStyles
    ? { ...inheritedStyles, ...node.textStyles }
    : inheritedStyles;

  for (const child of node.childNodes) {
    collectSegments(child, nextStyles, segments);
  }

  return segments;
}

describe("Divider coverage", () => {
  test("renders terminal-width, colored, titled, and too-narrow divider variants", async () => {
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <Box flexDirection="column">
          <Divider padding={14} />
          <Divider color="permission" char="=" width={5} />
          <Divider char="." title="Hi" width={10} />
          <Divider
            char="-"
            color="suggestion"
            title={"\u001b[1mWide\u001b[22m"}
            width={3}
          />
          <Divider char="+" padding={20} />
        </Box>,
      );
      await sleep(30);

      const theme = getTheme("dark");
      const segments = collectSegments(getRootNode(stdout));

      expect(segments.map(segment => segment.text).join("")).toBe(
        "──=====... Hi ... Wide ",
      );
      expect(segments).toEqual([
        { text: "──", styles: { color: theme.inactive } },
        { text: "=====", styles: { color: theme.permission } },
        { text: "...", styles: { color: theme.inactive } },
        { text: " ", styles: { color: theme.inactive } },
        { text: "Hi", styles: { color: theme.inactive } },
        { text: " ", styles: { color: theme.inactive } },
        { text: "...", styles: { color: theme.inactive } },
        { text: " ", styles: { color: theme.suggestion } },
        { text: "Wide", styles: { color: theme.inactive, bold: true } },
        { text: " ", styles: { color: theme.suggestion } },
      ]);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
