import { pathToFileURL } from "node:url";

import React from "react";
import { afterEach, describe, expect, test } from "vitest";

import { renderToAnsiString } from "../../utils/staticRender.js";
import { Box } from "../ink.js";
import { FilePathLink } from "./FilePathLink.js";

const previousForceHyperlink = process.env.FORCE_HYPERLINK;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectOsc8Link(output: string, url: string, label: string): void {
  const pattern = [
    "\\x1B\\]8;[^;\\x07]*;",
    escapeRegExp(url),
    "\\x07",
    escapeRegExp(label),
    "\\x1B\\]8;;\\x07",
  ].join("");

  expect(output).toMatch(new RegExp(pattern));
}

afterEach(() => {
  if (previousForceHyperlink === undefined) {
    delete process.env.FORCE_HYPERLINK;
  } else {
    process.env.FORCE_HYPERLINK = previousForceHyperlink;
  }
});

describe("FilePathLink coverage", () => {
  test("renders file paths as OSC 8 links with default and custom labels", async () => {
    process.env.FORCE_HYPERLINK = "1";

    const defaultPath = "/tmp/agenc workspace/report.md";
    const customPath = "/tmp/agenc workspace/src/FilePathLink.tsx";
    const output = await renderToAnsiString(
      <Box flexDirection="column">
        <FilePathLink filePath={defaultPath} />
        <FilePathLink filePath={customPath}>Open source</FilePathLink>
      </Box>,
      { columns: 120 },
    );

    expectOsc8Link(output, pathToFileURL(defaultPath).href, defaultPath);
    expectOsc8Link(output, pathToFileURL(customPath).href, "Open source");
  });
});
