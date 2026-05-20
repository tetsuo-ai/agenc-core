import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test } from "vitest";

import type { NormalizedMessage } from "../../types/message.js";
import type { DOMElement, DOMNode } from "../ink/dom.js";
import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";
import { stringWidth } from "../ink/stringWidth.js";
import type { TextStyles } from "../ink/styles.js";
import { MessageModel } from "./MessageModel.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type TextSegment = {
  text: string;
  styles: TextStyles;
};

function createStreams(): {
  stdin: TestStdin;
  stdout: PassThrough;
} {
  const stdin = new PassThrough() as TestStdin;
  const stdout = new PassThrough();

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  stdout.resume();

  return { stdin, stdout };
}

function assistantMessage(
  uuid: string,
  model: string | undefined,
  content: Array<Record<string, unknown>>,
): NormalizedMessage {
  return {
    message: {
      content,
      ...(model === undefined ? {} : { model }),
    },
    type: "assistant",
    uuid,
  } as NormalizedMessage;
}

function userMessage(uuid: string, model: string): NormalizedMessage {
  return {
    message: {
      content: [{ text: "user text", type: "text" }],
      model,
    },
    type: "user",
    uuid,
  } as NormalizedMessage;
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream);

  if (!instance?.rootNode) {
    throw new Error("Ink root node not found");
  }

  return instance.rootNode;
}

function collectTextSegments(
  node: DOMNode,
  inheritedStyles: TextStyles = {},
  segments: TextSegment[] = [],
): TextSegment[] {
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
    collectTextSegments(child, nextStyles, segments);
  }

  return segments;
}

function findBoxWithMinWidth(
  node: DOMNode,
  minWidth: number,
): DOMElement | null {
  if (node.nodeName === "#text") {
    return null;
  }

  if (node.nodeName === "ink-box" && node.style.minWidth === minWidth) {
    return node;
  }

  for (const child of node.childNodes) {
    const found = findBoxWithMinWidth(child, minWidth);
    if (found) {
      return found;
    }
  }

  return null;
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

describe("MessageModel wave200 coverage", () => {
  test("renders only transcript assistant models that accompany text content", async () => {
    const visibleModel = "gpt-4.1-mini";
    const hiddenTranscriptModel = "hidden-transcript-model";
    const hiddenUserModel = "hidden-user-model";
    const hiddenToolOnlyModel = "hidden-tool-only-model";
    const messages = [
      {
        isTranscriptMode: false,
        message: assistantMessage("not-transcript", hiddenTranscriptModel, [
          { text: "not transcript", type: "text" },
        ]),
      },
      {
        isTranscriptMode: true,
        message: userMessage("user-message", hiddenUserModel),
      },
      {
        isTranscriptMode: true,
        message: assistantMessage("missing-model", undefined, [
          { text: "missing model", type: "text" },
        ]),
      },
      {
        isTranscriptMode: true,
        message: assistantMessage("tool-only", hiddenToolOnlyModel, [
          { id: "tool-1", input: {}, name: "Read", type: "tool_use" },
        ]),
      },
      {
        isTranscriptMode: true,
        message: assistantMessage("visible-model", visibleModel, [
          { id: "tool-2", input: {}, name: "Read", type: "tool_use" },
          { text: "visible answer", type: "text" },
        ]),
      },
    ];
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    const renderMessages = () => (
      <>
        {messages.map(({ isTranscriptMode, message }) => (
          <MessageModel
            key={message.uuid}
            isTranscriptMode={isTranscriptMode}
            message={message}
          />
        ))}
      </>
    );

    try {
      root.render(renderMessages());
      await sleep();
      root.render(renderMessages());
      await sleep();

      const rootNode = getRootNode(stdout);
      const segments = collectTextSegments(rootNode);

      expect(segments).toEqual([
        {
          text: visibleModel,
          styles: expect.objectContaining({
            color: expect.any(String),
          }),
        },
      ]);
      expect(findBoxWithMinWidth(rootNode, stringWidth(visibleModel) + 8)).not.toBeNull();
      expect(segments.map(segment => segment.text).join("")).not.toContain(
        "hidden",
      );
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
