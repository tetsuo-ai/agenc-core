import { PassThrough } from "node:stream";

import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => {
  const subscribers = new Set<() => void>();

  return {
    enabled: false,
    subscribers,
    totalCount: 0,
    reset() {
      subscribers.clear();
      this.enabled = false;
      this.totalCount = 0;
    },
    notify() {
      for (const subscriber of [...subscribers]) subscriber();
    },
    addViolations(count: number) {
      this.totalCount += count;
      this.notify();
    },
  };
});

vi.mock("../../keybindings/useShortcutDisplay.js", () => ({
  useShortcutDisplay: () => "ctrl+shift+o",
}));

vi.mock("../../../utils/sandbox/sandbox-runtime.js", () => ({
  SandboxManager: {
    isSandboxingEnabled: () => harness.enabled,
    getSandboxViolationStore: () => ({
      getTotalCount: () => harness.totalCount,
      subscribe: (subscriber: () => void) => {
        harness.subscribers.add(subscriber);
        return () => harness.subscribers.delete(subscriber);
      },
    }),
  },
}));

import { createRoot } from "../../ink.js";
import type { DOMElement, DOMNode } from "../../ink/dom.js";
import instances from "../../ink/instances.js";
import { SandboxPromptFooterHint } from "./SandboxPromptFooterHint.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function createStreams(): {
  stdin: TestStdin;
  stdout: PassThrough;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  stdout.resume();
  (stdout as unknown as { columns: number }).columns = 120;
  return { stdin, stdout };
}

function collectText(node: DOMNode): string {
  if (node.nodeName === "#text") return node.nodeValue;
  return node.childNodes.map(collectText).join("");
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream);
  if (!instance?.rootNode) throw new Error("Ink root node not found");
  return instance.rootNode;
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(message);
}

async function renderHint(): Promise<{
  dispose: () => Promise<void>;
  text: () => string;
}> {
  const { stdin, stdout } = createStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  root.render(<SandboxPromptFooterHint />);
  await sleep();

  return {
    dispose: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    },
    text: () => collectText(getRootNode(stdout)),
  };
}

describe("SandboxPromptFooterHint coverage", () => {
  beforeEach(() => {
    harness.reset();
  });

  test("renders only for recent sandbox violations and unsubscribes on unmount", async () => {
    const disabled = await renderHint();
    try {
      expect(disabled.text()).toBe("");
      expect(harness.subscribers.size).toBe(0);
    } finally {
      await disabled.dispose();
    }

    harness.enabled = true;
    harness.totalCount = 4;
    const enabled = await renderHint();
    try {
      await waitFor(
        () => harness.subscribers.size === 1,
        "sandbox violation subscriber was not registered",
      );
      expect(enabled.text()).toBe("");

      harness.notify();
      await sleep();
      expect(enabled.text()).toBe("");

      harness.addViolations(1);
      await waitFor(
        () => enabled.text().includes("Sandbox blocked 1 operation"),
        "singular sandbox violation hint was not rendered",
      );
      expect(enabled.text()).toContain("ctrl+shift+o for details");

      harness.addViolations(2);
      await waitFor(
        () => enabled.text().includes("Sandbox blocked 2 operations"),
        "plural sandbox violation hint was not rendered",
      );
    } finally {
      await enabled.dispose();
    }

    expect(harness.subscribers.size).toBe(0);
  });
});
