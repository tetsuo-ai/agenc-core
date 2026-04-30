import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";
import type { DOMElement, DOMNode } from "../ink/dom.js";
import { Message } from "./Message.js";
import type { TranscriptMessage } from "./MessageList.js";

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
  (stdout as unknown as { columns: number }).columns = 100;
  (stdout as unknown as { rows: number }).rows = 30;
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
  await new Promise((resolve) => setTimeout(resolve, 30));
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

function collectText(node: DOMNode): string {
  if (node.nodeName === "#text") return node.nodeValue;
  if (!("childNodes" in node)) return "";
  return node.childNodes.map(collectText).join("");
}

function rootText(stdout: PassThrough): string {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { rootNode?: DOMElement }
    | undefined;
  return instance?.rootNode ? collectText(instance.rootNode) : "";
}

function msg(partial: Partial<TranscriptMessage> & Pick<TranscriptMessage, "id" | "kind">): TranscriptMessage {
  return { turnId: "t1", content: "", timestamp: 0, ...partial };
}

describe("Message OpenClaude content-block parity", () => {
  test("renders assistant thinking, redacted thinking, and tool use blocks", async () => {
    const { stdout, unmount } = await mount(
      <Message
        message={msg({
          id: "a1",
          kind: "assistant",
          assistantContent: [
            { type: "thinking", text: "private reasoning" },
            { type: "redacted_thinking" },
            { type: "tool_use", name: "Read", input: { path: "src/app.ts" } },
            { type: "text", text: "final answer" },
          ],
        })}
      />,
    );
    const text = rootText(stdout);
    expect(text).toContain("thinking");
    expect(text).toContain("hidden");
    expect(text).toContain("Read");
    expect(text).toContain("final answer");
    unmount();
  });

  test("renders user images, attachments, system rows, and rich tool results", async () => {
    const { stdout, unmount } = await mount(
      <Message
        message={msg({
          id: "u1",
          kind: "user",
          userContent: [
            { type: "image", imageId: 2, imagePath: "/tmp/image.png" },
            { type: "tool_result", toolUseId: "call_1", content: "tool output" },
            { type: "attachment", label: "file", path: "README.md" },
          ],
        })}
      />,
    );
    const text = rootText(stdout);
    expect(text).toContain("Image #2");
    expect(text).toContain("tool output");
    expect(text).toContain("README.md");
    unmount();
  });
});
