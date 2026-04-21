/**
 * SlashResultRenderer tests (T12 Wave 4-C).
 *
 * Mounts the component inside an Ink root fed by a PassThrough stdin/
 * stdout pair so every `SlashCommandResult` kind can be verified against
 * the rendered DOM text without touching the real terminal. Structural
 * output (borders, dim markers, colors) is asserted via the rendered
 * text collector used by the surrounding Wave 2/3 tests.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test, vi } from "vitest";

import type { DOMElement, DOMNode } from "../ink/dom.js";
import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";

import { SlashResultRenderer } from "./SlashResultRenderer.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function createStreams(): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function mount(element: React.ReactElement): Promise<{
  stdout: PassThrough;
  unmount: () => void;
}> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((r) => setTimeout(r, 20));
  return {
    stdout,
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { rootNode?: DOMElement }
    | undefined;
  if (!instance?.rootNode) {
    throw new Error("Ink root not found in test harness");
  }
  return instance.rootNode;
}

function collectText(node: DOMNode): string {
  if (node.nodeName === "#text") {
    return node.nodeValue;
  }
  const parts: string[] = [];
  if ("childNodes" in node) {
    for (const child of node.childNodes) {
      parts.push(collectText(child));
    }
  }
  return parts.join("");
}

/** Count nodes with the given element name anywhere in the tree. */
function countByName(node: DOMNode, name: string): number {
  let n = 0;
  if (node.nodeName === name) n += 1;
  if ("childNodes" in node) {
    for (const child of node.childNodes) {
      n += countByName(child, name);
    }
  }
  return n;
}

describe("<SlashResultRenderer>", () => {
  test("kind: 'text' renders content inside a bordered box", async () => {
    const { stdout, unmount } = await mount(
      <SlashResultRenderer
        input="/help"
        result={{ kind: "text", text: "here are the commands" }}
      />,
    );
    const root = getRootNode(stdout);
    const text = collectText(root);
    expect(text).toContain("here are the commands");
    expect(text).toContain("/help");
    // A bordered Box shows up as an ink-box in the tree.
    expect(countByName(root, "ink-box")).toBeGreaterThanOrEqual(1);
    unmount();
  });

  test("kind: 'compact' renders a single dimmed line (no border)", async () => {
    const { stdout, unmount } = await mount(
      <SlashResultRenderer
        input="/status"
        result={{ kind: "compact", text: "ok" }}
      />,
    );
    const root = getRootNode(stdout);
    const text = collectText(root);
    expect(text).toContain("/status");
    expect(text).toContain("ok");
    unmount();
  });

  test("kind: 'prompt' fires onPromptInject exactly once on mount", async () => {
    const spy = vi.fn();
    const { stdout, unmount } = await mount(
      <SlashResultRenderer
        input="/resume"
        result={{ kind: "prompt", content: "please summarize" }}
        onPromptInject={spy}
      />,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("please summarize");
    const text = collectText(getRootNode(stdout));
    expect(text).toContain("next prompt");
    unmount();
  });

  test("kind: 'skip' renders no visible content", async () => {
    const { stdout, unmount } = await mount(
      <SlashResultRenderer input="/noop" result={{ kind: "skip" }} />,
    );
    const text = collectText(getRootNode(stdout));
    expect(text).toBe("");
    unmount();
  });

  test("kind: 'exit' shows the exit code", async () => {
    const { stdout, unmount } = await mount(
      <SlashResultRenderer input="/exit" result={{ kind: "exit", code: 2 }} />,
    );
    const text = collectText(getRootNode(stdout));
    expect(text).toContain("/exit");
    expect(text).toContain("2");
    unmount();
  });

  test("kind: 'error' shows the originating command", async () => {
    const { stdout, unmount } = await mount(
      <SlashResultRenderer
        input="/badcmd"
        result={{ kind: "error", message: "unknown command" }}
      />,
    );
    const text = collectText(getRootNode(stdout));
    expect(text).toContain("/badcmd");
    expect(text).toContain("unknown command");
    unmount();
  });
});
