import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, describe, expect, test } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import type { DOMElement } from "../ink/dom.js";
import { PromptInputHelpMenu } from "./PromptInputHelpMenu.js";
import { QueuedCommands } from "./QueuedCommands.js";

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

afterEach(() => {
  delete process.env.AGENC_HOME;
});

describe("Composer OpenClaude prompt parity", () => {
  test("help menu shortcut hints follow the active keybinding map", async () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-keybindings-"));
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "keybindings.json"),
        JSON.stringify({
          bindings: [
            {
              context: "Global",
              bindings: {
                "Ctrl+X": "app:toggleTranscript",
              },
            },
          ],
        }),
      );
      process.env.AGENC_HOME = home;

      const text = await renderText(<PromptInputHelpMenu />);

      expect(text).toContain("Ctrl+X for verbose output");
      expect(text).toContain("/ for commands");
      expect(text).toContain("@ for file paths");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("queued prompts render from the session queue contract", async () => {
    const text = await renderText(
      <QueuedCommands
        isStreaming
        session={{
          hasPendingInput: () => true,
          pendingInputCount: () => 3,
        }}
      />,
    );

    expect(text).toContain("3 messages queued for the next turn");
  });
});
