import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../../ink/root.js";
import { Box, Text } from "../../ink.js";
import { Tab, Tabs, useTabHeaderFocus, useTabsWidth } from "./Tabs.js";

const keybindingMock = vi.hoisted(() => ({
  registrations: [] as Array<{
    handlers: Record<string, () => void>;
    options: { isActive?: boolean };
  }>,
}));

vi.mock("../../keybindings/useKeybinding.js", () => ({
  useKeybindings: (
    handlers: Record<string, () => void>,
    options: { isActive?: boolean },
  ) => {
    keybindingMock.registrations.push({ handlers, options });
  },
}));

async function renderTabsToText(node: React.ReactNode): Promise<string> {
  let output = "";
  const stdout = new PassThrough();
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number }).columns = 90;

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  try {
    root.render(node);
    await new Promise(resolve => setTimeout(resolve, 30));
    return stripAnsi(output);
  } finally {
    root.unmount();
    stdin.end();
  }
}

function WidthProbe() {
  const width = useTabsWidth();
  return <Text>width {width}</Text>;
}

function FocusProbe() {
  const { blurHeader, focusHeader, headerFocused } = useTabHeaderFocus();
  React.useEffect(() => {
    blurHeader();
    focusHeader();
  }, [blurHeader, focusHeader]);
  return <Text>header {String(headerFocused)}</Text>;
}

describe("Tabs rendering", () => {
  beforeEach(() => {
    keybindingMock.registrations = [];
  });

  test("renders selected tab content, banner, full-width context, and header", async () => {
    const output = await renderTabsToText(
      <Tabs
        title="Tools"
        color="permission"
        defaultTab="second"
        useFullWidth
        banner={<Text>banner text</Text>}
        contentHeight={3}
      >
        <Tab id="first" title="First">
          <Text>first content</Text>
        </Tab>
        <Tab id="second" title="Second">
          <Box flexDirection="column">
            <Text>second content</Text>
            <WidthProbe />
            <FocusProbe />
          </Box>
        </Tab>
      </Tabs>,
    );

    expect(output).toContain("Tools");
    expect(output).toContain("First");
    expect(output).toContain("Second");
    expect(output).toContain("banner text");
    expect(output).toContain("second content");
    expect(output).toContain("width 90");
    expect(output).toContain("header true");
    expect(output).not.toContain("first content");
    expect(keybindingMock.registrations.some(reg => reg.options.isActive)).toBe(
      true,
    );
  });

  test("controlled tabs report navigation instead of mutating internal state", async () => {
    const onTabChange = vi.fn();

    await renderTabsToText(
      <Tabs selectedTab="first" onTabChange={onTabChange}>
        <Tab id="first" title="First">
          <Text>first content</Text>
        </Tab>
        <Tab id="second" title="Second">
          <Text>second content</Text>
        </Tab>
      </Tabs>,
    );

    keybindingMock.registrations
      .find(reg => reg.options.isActive)
      ?.handlers["tabs:next"]();
    expect(onTabChange).toHaveBeenCalledWith("second");

    keybindingMock.registrations
      .find(reg => reg.options.isActive)
      ?.handlers["tabs:previous"]();
    expect(onTabChange).toHaveBeenCalledWith("second");
  });

  test("hidden tabs suppress the header while keeping selected content", async () => {
    const output = await renderTabsToText(
      <Tabs hidden defaultTab="only" disableNavigation initialHeaderFocused={false}>
        <Tab id="only" title="Only">
          <Text>hidden content</Text>
        </Tab>
        <Tab id="other" title="Other">
          <Text>other content</Text>
        </Tab>
      </Tabs>,
    );

    expect(output).toContain("hidden content");
    expect(output).not.toContain("Only");
    expect(output).not.toContain("other content");
    expect(keybindingMock.registrations.every(reg => !reg.options.isActive)).toBe(
      true,
    );
  });
});
