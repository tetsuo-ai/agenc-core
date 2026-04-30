import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import type { DOMElement } from "../ink/dom.js";
import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";
import PromptInputFooter from "./PromptInputFooter.js";

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
  await new Promise((resolve) => setTimeout(resolve, 60));
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

describe("PromptInputFooter OpenClaude parity", () => {
  test("owns the configurable status line inside the footer", async () => {
    const text = await renderText(
      <PromptInputFooter
        exitMessage={{ show: false }}
        mode="prompt"
        permissionMode="default"
        suggestions={[]}
        selectedSuggestion={0}
        helpOpen={false}
        suppressHint={false}
        isLoading={false}
        isSearching={false}
        statusLineItems={["model", "mode", "cwd"]}
        statusLineSession={{
          model: "grok-code-fast-1",
          mode: "default",
        }}
        statusLineCwd="/tmp/agenc-footer"
      />,
    );

    expect(text).toContain("model");
    expect(text).toContain("grok-code-fast-1");
    expect(text).toContain("mode");
    expect(text).toContain("default");
    expect(text).toContain("cwd");
    expect(text).toContain("agenc-footer");
    expect(text).not.toContain("Type prompt. / commands.");
  });

  test("suggestions replace the normal footer body", async () => {
    const text = await renderText(
      <PromptInputFooter
        exitMessage={{ show: false }}
        mode="prompt"
        permissionMode="default"
        suggestions={[
          {
            id: "file-src-index",
            displayText: "src/index.ts",
            description: "entrypoint",
          },
        ]}
        selectedSuggestion={0}
        helpOpen={false}
        suppressHint={false}
        isLoading={false}
        isSearching={false}
        statusLineItems={["model"]}
        statusLineSession={{ model: "should-not-render" }}
      />,
    );

    expect(text).toContain("src/index.ts");
    expect(text).toContain("entrypoint");
    expect(text).not.toContain("should-not-render");
  });

  test("help menu is rendered by the footer", async () => {
    const text = await renderText(
      <PromptInputFooter
        exitMessage={{ show: false }}
        mode="prompt"
        permissionMode="default"
        suggestions={[]}
        selectedSuggestion={0}
        helpOpen
        suppressHint={false}
        isLoading={false}
        isSearching={false}
      />,
    );

    expect(text).toContain("/ for commands");
    expect(text).toContain("@ for file paths");
    expect(text).toContain("Shift+Tab to auto-accept edits");
  });
});
