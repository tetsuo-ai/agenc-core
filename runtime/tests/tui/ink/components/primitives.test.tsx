import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test } from "vitest";

import { renderToAnsiString, renderToString } from "../../../utils/staticRender.js";
import type { DOMElement } from "../dom.ts";
import instances from "../instances.ts";
import { createRoot } from "../root.ts";
import ErrorOverview from "./ErrorOverview.js";
import Newline from "./Newline.js";
import { RawAnsi } from "./RawAnsi.js";
import Spacer from "./Spacer.js";
import Text from "./Text.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function createTestStreams(): {
  stdin: TestStdin;
  stdout: PassThrough;
} {
  const stdout = new PassThrough();
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  return { stdin, stdout };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

function findElement(node: DOMElement, nodeName: string): DOMElement | null {
  if (node.nodeName === nodeName) return node;
  for (const child of node.childNodes) {
    const found = findElement(child, nodeName);
    if (found) return found;
  }
  return null;
}

describe("Ink primitive components", () => {
  test("ErrorOverview renders fallback messages and stack frames", async () => {
    const errorWithStack = new Error("boom");
    errorWithStack.stack = "Error: boom\n    at first\n    at second";

    const withStack = await renderToString(
      <ErrorOverview error={errorWithStack} />,
      120,
    );

    expect(withStack).toContain("ERROR");
    expect(withStack).toContain("boom");
    expect(withStack).toContain("at first");
    expect(withStack).toContain("at second");

    const emptyMessage = new Error("");
    emptyMessage.stack = undefined;
    const fallback = await renderToString(
      <ErrorOverview error={emptyMessage} />,
      120,
    );

    expect(fallback).toContain("Unknown error");
  });

  test("Newline emits one or more text newlines", async () => {
    const defaultOutput = await renderToString(
      <Text>
        a
        <Newline />
        b
      </Text>,
      80,
    );
    const countedOutput = await renderToString(
      <Text>
        a
        <Newline count={3} />
        b
      </Text>,
      80,
    );

    expect(defaultOutput).toContain("a\nb");
    expect(countedOutput).toContain("a\n\n\nb");
  });

  test("RawAnsi renders raw ANSI text and only renderer whitespace for empty lines", async () => {
    const ansi = await renderToAnsiString(
      <RawAnsi lines={["\x1b[31mred\x1b[0m", "plain"]} width={12} />,
      { columns: 80, color: true },
    );
    const empty = await renderToString(<RawAnsi lines={[]} width={12} />, 80);

    expect(ansi).toContain("\x1b[31mred");
    expect(ansi).toContain("plain");
    expect(empty.trim()).toBe("");
  });

  test("Spacer mounts an expanding Box", async () => {
    const { stdin, stdout } = createTestStreams();
    const root = await createRoot({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    });

    try {
      root.render(<Spacer />);
      await waitFor(() => {
        const instance = instances.get(stdout as unknown as NodeJS.WriteStream);
        return Boolean(instance?.rootNode);
      });
      const instance = instances.get(stdout as unknown as NodeJS.WriteStream);
      const spacer = instance?.rootNode
        ? findElement(instance.rootNode, "ink-box")
        : null;

      expect(spacer).not.toBeNull();
      expect(spacer?.style.flexGrow).toBe(1);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
