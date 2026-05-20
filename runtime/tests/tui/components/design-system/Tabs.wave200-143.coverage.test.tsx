import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test, vi } from "vitest";

import type { DOMElement, DOMNode } from "../../ink/dom.js";
import instances from "../../ink/instances.js";
import { createRoot } from "../../ink/root.js";
import { Text } from "../../ink.js";
import { Tab, Tabs, useTabHeaderFocus } from "./Tabs.js";

const keybindingMock = vi.hoisted(() => ({
  registrations: [] as Array<{
    handlers: Record<string, () => void>;
    options: { context?: string; isActive?: boolean };
  }>,
}));

vi.mock("../../keybindings/useKeybinding.js", () => ({
  useKeybindings: (
    handlers: Record<string, () => void>,
    options: { context?: string; isActive?: boolean },
  ) => {
    keybindingMock.registrations.push({ handlers, options });
  },
}));

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
  const stdin = new PassThrough() as TestStdin;
  const stdout = new PassThrough();

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  stdout.resume();
  (stdout as unknown as { columns: number; isTTY: boolean; rows: number }).columns = 80;
  (stdout as unknown as { columns: number; isTTY: boolean; rows: number }).rows = 24;
  (stdout as unknown as { columns: number; isTTY: boolean; rows: number }).isTTY = true;

  return { stdin, stdout };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 2_000) {
    if (predicate()) return;
    await sleep(10);
  }

  throw new Error(message);
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream);

  if (!instance?.rootNode) {
    throw new Error("Ink root node not found");
  }

  return instance.rootNode;
}

function findKeyboardElement(node: DOMNode): DOMElement | undefined {
  if (node.nodeName !== "#text" && node._eventHandlers?.onKeyDown) {
    return node;
  }

  for (const child of node.childNodes) {
    const found = findKeyboardElement(child);
    if (found) return found;
  }

  return undefined;
}

function latestActiveTabsRegistration(): {
  handlers: Record<string, () => void>;
  options: { context?: string; isActive?: boolean };
} {
  const registration = keybindingMock.registrations
    .toReversed()
    .find(reg => reg.options.context === "Tabs" && reg.options.isActive);

  if (!registration) {
    throw new Error("Expected an active Tabs keybinding registration");
  }

  return registration;
}

function FocusedTab({
  label,
  snapshots,
}: {
  label: string;
  snapshots: string[];
}) {
  const { headerFocused } = useTabHeaderFocus();

  React.useEffect(() => {
    snapshots.push(`${label}:${String(headerFocused)}`);
  }, [headerFocused, label, snapshots]);

  return (
    <Text>
      {label}:{String(headerFocused)}
    </Text>
  );
}

describe("Tabs wave200-143 coverage", () => {
  test("hands focus to opted-in tab content and restores it after content navigation", async () => {
    keybindingMock.registrations = [];
    const snapshots: string[] = [];
    const { stdin, stdout } = createTestStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <Tabs navFromContent>
          <Tab id="first" title="First">
            <FocusedTab label="first" snapshots={snapshots} />
          </Tab>
          <Tab id="second" title="Second">
            <FocusedTab label="second" snapshots={snapshots} />
          </Tab>
        </Tabs>,
      );

      await waitFor(
        () => snapshots.includes("first:true"),
        "first tab did not render with header focus",
      );
      await waitFor(
        () => keybindingMock.registrations.length >= 4,
        "tab content did not opt into header-focus handoff",
      );

      const keyboardElement = findKeyboardElement(getRootNode(stdout));
      expect(keyboardElement).toBeDefined();

      const preventDefault = vi.fn();
      keyboardElement?._eventHandlers?.onKeyDown?.({
        key: "down",
        preventDefault,
      } as never);

      await waitFor(
        () => snapshots.includes("first:false"),
        "down arrow did not hand focus to tab content",
      );
      expect(preventDefault).toHaveBeenCalledOnce();

      latestActiveTabsRegistration().handlers["tabs:next"]();
      await waitFor(
        () => snapshots.includes("second:true"),
        "content navigation did not select next tab and restore header focus",
      );

      keyboardElement?._eventHandlers?.onKeyDown?.({
        key: "down",
        preventDefault: vi.fn(),
      } as never);
      await waitFor(
        () => snapshots.includes("second:false"),
        "second tab did not hand focus back to content",
      );

      latestActiveTabsRegistration().handlers["tabs:previous"]();
      await waitFor(
        () => snapshots.filter(snapshot => snapshot === "first:true").length >= 2,
        "content navigation did not select previous tab and restore header focus",
      );
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep(25);
    }
  });
});
