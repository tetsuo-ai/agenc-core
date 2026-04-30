import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import type { DOMElement } from "../ink/dom.js";
import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";
import { PromptInputFooterLeftSide } from "./PromptInputFooterLeftSide.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function streams(): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = 100;
  (stdout as unknown as { rows: number }).rows = 32;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

function collectText(node: DOMElement): string {
  const parts: string[] = [];
  const walk = (n: DOMElement): void => {
    for (const child of n.childNodes) {
      if (child.nodeName === "#text") {
        parts.push((child as unknown as { nodeValue: string }).nodeValue ?? "");
      } else {
        walk(child as DOMElement);
      }
    }
  };
  walk(node);
  return parts.join("");
}

async function renderText(element: React.ReactElement): Promise<string> {
  const { stdout, stdin } = streams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { rootNode?: DOMElement }
    | undefined;
  const text = instance?.rootNode ? collectText(instance.rootNode) : "";
  root.unmount();
  instances.delete(stdout as unknown as NodeJS.WriteStream);
  stdin.end();
  stdout.end();
  return text;
}

describe("PromptInputFooterLeftSide OpenClaude parity", () => {
  test("exit confirmation takes priority over status and mode", async () => {
    const text = await renderText(
      <PromptInputFooterLeftSide
        exitMessage={{ show: true, key: "Ctrl+D" }}
        mode="prompt"
        permissionMode="auto"
        suppressHint={false}
        isLoading
        status={{ color: "warning", text: "Working" }}
      />,
    );

    expect(text).toContain("Press Ctrl+D again to exit");
    expect(text).not.toContain("Working");
    expect(text).not.toContain("auto");
  });

  test("paste status takes priority over status and mode", async () => {
    const text = await renderText(
      <PromptInputFooterLeftSide
        exitMessage={{ show: false }}
        mode="prompt"
        permissionMode="plan"
        suppressHint={false}
        isLoading
        isPasting
        status={{ color: "warning", text: "Approval pending" }}
      />,
    );

    expect(text).toContain("Pasting text");
    expect(text).not.toContain("Approval pending");
    expect(text).not.toContain("plan");
  });

  test("renders status, permission mode, and interrupt hint in one footer row", async () => {
    const text = await renderText(
      <PromptInputFooterLeftSide
        exitMessage={{ show: false }}
        mode="prompt"
        permissionMode="auto"
        suppressHint={false}
        isLoading
        pendingRequestCount={1}
        status={{ color: "warning", text: "Approval pending (Y/N/A/D)" }}
      />,
    );

    expect(text).toContain("Approval pending (Y/N/A/D)");
    expect(text).toContain("auto");
    expect(text).toContain("interrupt");
  });
});
