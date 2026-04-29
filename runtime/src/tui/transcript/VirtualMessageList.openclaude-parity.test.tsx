import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";
import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import {
  VirtualMessageList,
  type JumpHandle,
  type MessageActionsNav,
} from "./VirtualMessageList.js";
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
  (stdout as unknown as { columns: number }).columns = 80;
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

function message(
  id: string,
  content: string,
  kind: TranscriptMessage["kind"] = "assistant",
): TranscriptMessage {
  return {
    id,
    turnId: "t1",
    kind,
    content,
    timestamp: 0,
  };
}

function scrollHarness(): ScrollBoxHandle & { readonly calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    scrollTo: (y) => calls.push(y),
    scrollBy: (dy) => calls.push(dy),
    scrollToElement: () => undefined,
    scrollToBottom: () => calls.push(Number.POSITIVE_INFINITY),
    getScrollTop: () => 10,
    getPendingDelta: () => 0,
    getScrollHeight: () => 100,
    getFreshScrollHeight: () => 100,
    getViewportHeight: () => 10,
    getViewportTop: () => 0,
    isSticky: () => false,
    subscribe: () => () => undefined,
    setClampBounds: () => undefined,
  };
}

describe("VirtualMessageList OpenClaude parity", () => {
  test("warms search, jumps matches, tracks sticky prompt, and exposes cursor nav", async () => {
    const scroll = scrollHarness();
    const jumpRef = React.createRef<JumpHandle | null>();
    const cursorNavRef = React.createRef<MessageActionsNav | null>();
    const matches: Array<[number, number]> = [];
    const cursors: string[] = [];
    const sticky: string[] = [];
    const rows = [
      message("u1", "first prompt", "user"),
      message("a1", "needle one"),
      message("a2", "needle two"),
    ];

    const { unmount } = await mount(
      <VirtualMessageList
        messages={rows}
        scrollRef={{ current: scroll }}
        columns={80}
        itemKey={(row) => row.id}
        renderItem={(row) => row.content}
        extractSearchText={(row) => row.content.toLowerCase()}
        jumpRef={jumpRef}
        cursorNavRef={cursorNavRef}
        setCursor={(cursor) => {
          if (cursor) cursors.push(cursor.id);
        }}
        trackStickyPrompt
        onStickyPromptChange={(prompt) => {
          if (prompt) sticky.push(prompt.text);
        }}
        onSearchMatchesChange={(total, current) => matches.push([total, current])}
        isItemClickable={() => true}
        onItemClick={() => undefined}
      />,
    );

    await expect(jumpRef.current?.warmSearchIndex()).resolves.toBeGreaterThanOrEqual(0);
    jumpRef.current?.setAnchor();
    jumpRef.current?.setSearchQuery("needle");
    jumpRef.current?.nextMatch();
    jumpRef.current?.prevMatch();
    cursorNavRef.current?.moveTo(2);

    expect(matches).toContainEqual([2, 1]);
    expect(matches).toContainEqual([2, 2]);
    expect(scroll.calls.length).toBeGreaterThan(0);
    expect(cursors).toContain("a2");
    expect(sticky[0]).toContain("first prompt");

    unmount();
  });
});
