/**
 * Wave 4-B ArtPanel tests.
 *
 * The watch/agenc-watch-art.mjs module is present in the repo so we
 * cannot easily unload it to force the fallback path. Instead we mount
 * the panel with various `visible` / `variant` combinations and assert
 * on the inline ASCII fallback content — which is what we render today
 * regardless of whether the dynamic import succeeded, because the
 * watch module requires an `imagePath` we are not supplying.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import type { DOMElement } from "../ink/dom.js";
import { ArtPanel, __resetArtPanelForTests } from "./ArtPanel.js";

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
  (stdout as unknown as { columns: number }).columns = 120;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function mount(element: React.ReactElement): Promise<{
  unmount: () => void;
  stdout: PassThrough;
}> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((r) => setTimeout(r, 30));
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

function getRoot(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { rootNode?: DOMElement }
    | undefined;
  if (!instance?.rootNode) throw new Error("Ink instance root missing");
  return instance.rootNode;
}

describe("ArtPanel", () => {
  test("renders nothing when visible is false", async () => {
    __resetArtPanelForTests();
    const { stdout, unmount } = await mount(<ArtPanel visible={false} />);
    const text = collectText(getRoot(stdout));
    // Neither the small nor the large fallback characters should leak.
    expect(text).not.toContain("__ _");
    expect(text).not.toContain("▄████████");
    unmount();
  });

  test("renders the inline ASCII fallback when watch module is unavailable or unwired", async () => {
    __resetArtPanelForTests();
    const { stdout, unmount } = await mount(<ArtPanel />);
    const text = collectText(getRoot(stdout));
    // The small fallback is a 5-line Figlet-style banner; check for
    // two of the signature rows to confirm we're on the fallback path.
    expect(text).toContain("__ _");
    expect(text).toContain("___");
    unmount();
  });

  test("variant 'large' vs 'small' produces different output", async () => {
    __resetArtPanelForTests();
    const small = await mount(<ArtPanel variant="small" />);
    const smallText = collectText(getRoot(small.stdout));
    small.unmount();

    __resetArtPanelForTests();
    const large = await mount(<ArtPanel variant="large" />);
    const largeText = collectText(getRoot(large.stdout));
    large.unmount();

    expect(smallText).not.toEqual(largeText);
    // Large uses block drawing characters; small uses plain ASCII.
    expect(largeText).toContain("▄");
    expect(smallText).not.toContain("▄");
  });
});
