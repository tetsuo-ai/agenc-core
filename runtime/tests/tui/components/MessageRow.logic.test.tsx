import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  allToolsResolved,
  areMessageRowPropsEqual,
  hasContentAfterIndex,
  isMessageStreaming,
  type Props,
} from "./MessageRow.js";

const rowMock = vi.hoisted(() => ({
  collapsibleToolNames: new Set<string>(["Read", "Grep", "GroupedRead"]),
}));

vi.mock("../../utils/collapseReadSearch.js", () => ({
  getDisplayMessageFromCollapsed: (message: any) => message.displayMessage ?? message,
  getToolSearchOrReadInfo: (name: string) => ({
    isCollapsible: rowMock.collapsibleToolNames.has(name),
  }),
  getToolUseIdsFromCollapsedGroup: (message: { toolUseIds?: string[] }) =>
    message.toolUseIds ?? [],
  hasAnyToolInProgress: (message: { toolUseIds?: string[] }, ids: Set<string>) =>
    (message.toolUseIds ?? []).some(id => ids.has(id)),
}));

vi.mock("../../utils/messages.js", () => ({
  EMPTY_STRING_SET: new Set<string>(),
  getProgressMessagesFromLookup: () => [],
  getSiblingToolUseIDsFromLookup: () => new Set<string>(),
  getToolUseID: (message: any) => {
    const block = message?.message?.content?.[0];
    return block?.id ?? null;
  },
}));

vi.mock("./Message.js", () => ({
  Message: () => null,
  hasThinkingContent: (message: any) =>
    message?.message?.content?.some((block: any) =>
      block.type === "thinking" || block.type === "redacted_thinking",
    ) ?? false,
}));

vi.mock("./Messages.js", () => ({
  shouldRenderStatically: () => true,
}));

vi.mock("./MessageModel.js", () => ({
  MessageModel: () => null,
}));

vi.mock("./MessageTimestamp.js", () => ({
  MessageTimestamp: () => null,
}));

vi.mock("./OffscreenFreeze.js", () => ({
  OffscreenFreeze: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function assistantBlock(block: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    message: { content: [block], model: "gpt-test" },
    timestamp: "2026-05-20T00:00:00.000Z",
    type: "assistant",
    uuid: `assistant-${String(block.id ?? block.type)}`,
    ...overrides,
  };
}

function userBlock(block: Record<string, unknown>) {
  return {
    message: { content: [block] },
    type: "user",
    uuid: `user-${String(block.type)}`,
  };
}

function groupedToolUse(id: string, toolName = "GroupedRead") {
  return {
    displayMessage: assistantBlock({ text: "group display", type: "text" }),
    messages: [assistantBlock({ id, input: {}, name: toolName, type: "tool_use" })],
    toolName,
    type: "grouped_tool_use",
    uuid: `group-${id}`,
  };
}

function collapsed(ids: string[], overrides: Record<string, unknown> = {}) {
  return {
    displayMessage: assistantBlock({ text: "collapsed display", type: "text" }),
    messages: [],
    readCount: 1,
    searchCount: 0,
    toolUseIds: ids,
    type: "collapsed_read_search",
    uuid: `collapsed-${ids.join("-")}`,
    ...overrides,
  };
}

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    canAnimate: true,
    columns: 80,
    commands: [],
    hasContentAfter: false,
    inProgressToolUseIDs: new Set<string>(),
    isLoading: false,
    isUserContinuation: false,
    lastThinkingBlockId: null,
    latestBashOutputUUID: null,
    lookups: {
      resolvedToolUseIDs: new Set<string>(),
    } as any,
    message: assistantBlock({ text: "hello", type: "text" }) as any,
    screen: "default" as any,
    streamingToolUseIDs: new Set<string>(),
    tools: {} as any,
    verbose: false,
    ...overrides,
  };
}

beforeEach(() => {
  rowMock.collapsibleToolNames = new Set(["Read", "Grep", "GroupedRead"]);
});

describe("hasContentAfterIndex", () => {
  test("skips transient non-content messages and returns false at the end", () => {
    const messages = [
      collapsed(["read-1"]),
      assistantBlock({ text: "thinking", type: "thinking" }),
      assistantBlock({ text: "redacted", type: "redacted_thinking" }),
      assistantBlock({ id: "read-1", input: {}, name: "Read", type: "tool_use" }),
      assistantBlock({ id: "streaming-shell", input: {}, name: "Bash", type: "tool_use" }),
      { type: "system", uuid: "system" },
      { type: "attachment", uuid: "attachment" },
      userBlock({ tool_use_id: "read-1", type: "tool_result" }),
      groupedToolUse("grouped-1"),
    ] as any[];

    expect(
      hasContentAfterIndex(messages, 0, {} as any, new Set(["streaming-shell"])),
    ).toBe(false);
  });

  test("detects assistant, user, and non-collapsible grouped content", () => {
    expect(
      hasContentAfterIndex(
        [collapsed(["read-1"]), assistantBlock({ text: "real", type: "text" })] as any[],
        0,
        {} as any,
        new Set(),
      ),
    ).toBe(true);
    expect(
      hasContentAfterIndex(
        [collapsed(["read-1"]), userBlock({ text: "real", type: "text" })] as any[],
        0,
        {} as any,
        new Set(),
      ),
    ).toBe(true);

    rowMock.collapsibleToolNames.delete("GroupedRead");
    expect(
      hasContentAfterIndex([collapsed(["read-1"]), groupedToolUse("grouped-1")] as any[], 0, {} as any, new Set()),
    ).toBe(true);
  });
});

describe("message streaming and resolution helpers", () => {
  test("detects streaming grouped, collapsed, and single tool-use messages", () => {
    expect(isMessageStreaming(groupedToolUse("grouped-1") as any, new Set(["grouped-1"]))).toBe(true);
    expect(isMessageStreaming(collapsed(["read-1"]) as any, new Set(["read-1"]))).toBe(true);
    expect(
      isMessageStreaming(
        assistantBlock({ id: "tool-1", input: {}, name: "Bash", type: "tool_use" }) as any,
        new Set(["tool-1"]),
      ),
    ).toBe(true);
    expect(isMessageStreaming(assistantBlock({ text: "done", type: "text" }) as any, new Set())).toBe(false);
  });

  test("detects resolved grouped, collapsed, server, normal, and text messages", () => {
    expect(allToolsResolved(groupedToolUse("grouped-1") as any, new Set(["grouped-1"]))).toBe(true);
    expect(allToolsResolved(groupedToolUse("grouped-1") as any, new Set())).toBe(false);
    expect(allToolsResolved(collapsed(["read-1", "read-2"]) as any, new Set(["read-1", "read-2"]))).toBe(true);
    expect(allToolsResolved(collapsed(["read-1", "read-2"]) as any, new Set(["read-1"]))).toBe(false);
    expect(
      allToolsResolved(
        assistantBlock({ id: "server-1", name: "web_search", type: "server_tool_use" }) as any,
        new Set(["server-1"]),
      ),
    ).toBe(true);
    expect(
      allToolsResolved(
        assistantBlock({ id: "tool-1", input: {}, name: "Bash", type: "tool_use" }) as any,
        new Set(["tool-1"]),
      ),
    ).toBe(true);
    expect(allToolsResolved(assistantBlock({ text: "done", type: "text" }) as any, new Set())).toBe(true);
  });
});

describe("areMessageRowPropsEqual", () => {
  test("rejects prop changes that affect rendering", () => {
    const message = assistantBlock({ text: "hello", type: "text" }) as any;
    const prev = baseProps({ message });

    expect(areMessageRowPropsEqual(prev, baseProps({ message: assistantBlock({ text: "new", type: "text" }) as any }))).toBe(false);
    expect(areMessageRowPropsEqual(prev, baseProps({ message, screen: "transcript" as any }))).toBe(false);
    expect(areMessageRowPropsEqual(prev, baseProps({ message, verbose: true }))).toBe(false);
    expect(areMessageRowPropsEqual(prev, baseProps({ columns: 120, message }))).toBe(false);
    expect(areMessageRowPropsEqual(baseProps({ latestBashOutputUUID: "other", message }), baseProps({ latestBashOutputUUID: message.uuid, message }))).toBe(false);
  });

  test("keeps thinking rows sensitive to the active thinking block", () => {
    const message = assistantBlock({ text: "thinking", type: "thinking" }) as any;

    expect(
      areMessageRowPropsEqual(
        baseProps({ lastThinkingBlockId: "old", message }),
        baseProps({ lastThinkingBlockId: "new", message }),
      ),
    ).toBe(false);
    const textMessage = baseProps().message;
    expect(
      areMessageRowPropsEqual(
        baseProps({ lastThinkingBlockId: "old", message: textMessage }),
        baseProps({ lastThinkingBlockId: "new", message: textMessage }),
      ),
    ).toBe(true);
  });

  test("rejects active or unresolved rows and accepts static resolved rows", () => {
    const message = assistantBlock({ id: "tool-1", input: {}, name: "Bash", type: "tool_use" }) as any;
    const resolved = baseProps({
      lookups: { resolvedToolUseIDs: new Set(["tool-1"]) } as any,
      message,
    });

    expect(
      areMessageRowPropsEqual(
        baseProps({ message, streamingToolUseIDs: new Set(["tool-1"]) }),
        resolved,
      ),
    ).toBe(false);
    expect(
      areMessageRowPropsEqual(
        baseProps({ lookups: { resolvedToolUseIDs: new Set() } as any, message }),
        resolved,
      ),
    ).toBe(false);
    expect(areMessageRowPropsEqual(resolved, resolved)).toBe(true);
  });

  test("never memo-skips collapsed prompt rows", () => {
    const message = collapsed(["read-1"]) as any;
    const props = baseProps({ message });

    expect(areMessageRowPropsEqual(props, props)).toBe(false);
  });
});
