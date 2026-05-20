import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; props: Record<string, unknown> }>,
  collapsibleTools: new Set<string>(),
  staticMessages: new Set<string>(),
  reset() {
    harness.calls = [];
    harness.collapsibleTools = new Set();
    harness.staticMessages = new Set();
  },
}));

vi.mock("../../utils/collapseReadSearch.js", () => ({
  getDisplayMessageFromCollapsed: (message: { displayMessage?: unknown }) =>
    message.displayMessage,
  getToolSearchOrReadInfo: (name: string) => ({
    isCollapsible: harness.collapsibleTools.has(name),
  }),
  getToolUseIdsFromCollapsedGroup: (message: { toolUseIds?: string[] }) =>
    message.toolUseIds ?? [],
  hasAnyToolInProgress: (
    message: { toolUseIds?: string[] },
    inProgressToolUseIDs: Set<string>,
  ) => (message.toolUseIds ?? []).some(id => inProgressToolUseIDs.has(id)),
}));

vi.mock("../../utils/messages.js", () => ({
  EMPTY_STRING_SET: new Set<string>(),
  getProgressMessagesFromLookup: (
    message: { uuid: string },
    lookups: { progress?: Record<string, string[]> },
  ) => lookups.progress?.[message.uuid] ?? [],
  getSiblingToolUseIDsFromLookup: (
    message: { uuid: string },
    lookups: { siblings?: Record<string, string[]> },
  ) => new Set(lookups.siblings?.[message.uuid] ?? []),
  getToolUseID: (message: {
    message?: { content?: Array<{ id?: string; type?: string }> };
    toolUseID?: string;
  }) => message.toolUseID ?? message.message?.content?.[0]?.id,
}));

vi.mock("./Message.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../ink.js");
  return {
    hasThinkingContent: (message: {
      hasThinking?: boolean;
      message?: { content?: Array<{ type?: string }> };
    }) =>
      Boolean(message.hasThinking) ||
      Boolean(
        message.message?.content?.some(
          content =>
            content.type === "thinking" ||
            content.type === "redacted_thinking",
        ),
      ),
    Message: (props: Record<string, unknown>) => {
      const message = props.message as { type: string; uuid: string };
      harness.calls.push({ name: "Message", props });
      return ReactModule.createElement(
        Text,
        null,
        `Message:${message.uuid}:${message.type}:${String(props.shouldAnimate)}:${String(props.isStatic)}:${String(props.isActiveCollapsedGroup)}:${String(props.containerWidth ?? "none")}`,
      );
    },
  };
});

vi.mock("./MessageModel.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../ink.js");
  return {
    MessageModel: ({ message }: { readonly message: { uuid: string } }) =>
      ReactModule.createElement(Text, null, `Model:${message.uuid}`),
  };
});

vi.mock("./Messages.js", () => ({
  shouldRenderStatically: (message: { uuid: string }) =>
    harness.staticMessages.has(message.uuid),
}));

vi.mock("./MessageTimestamp.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../ink.js");
  return {
    MessageTimestamp: ({ message }: { readonly message: { uuid: string } }) =>
      ReactModule.createElement(Text, null, `Timestamp:${message.uuid}`),
  };
});

vi.mock("./OffscreenFreeze.js", async () => {
  const ReactModule = await import("react");
  return {
    OffscreenFreeze: ({ children }: { readonly children?: React.ReactNode }) => {
      harness.calls.push({ name: "OffscreenFreeze", props: {} });
      return ReactModule.createElement(ReactModule.Fragment, null, children);
    },
  };
});

import { createRoot } from "../ink/root.js";
import {
  allToolsResolved,
  areMessageRowPropsEqual,
  hasContentAfterIndex,
  isMessageStreaming,
  MessageRow,
  type Props,
} from "./MessageRow.js";

function createStreams(): {
  stdout: PassThrough;
  stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  stdout.resume();
  return { stdin, stdout };
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function textBlock(text = "hello"): Record<string, unknown> {
  return { text, type: "text" };
}

function toolUseBlock(
  id: string,
  name = "Agent",
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, input, name, type: "tool_use" };
}

function assistant(
  uuid: string,
  content: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Props["message"] {
  return {
    message: {
      content,
      model: overrides.model,
    },
    type: "assistant",
    uuid,
    ...overrides,
  } as Props["message"];
}

function userToolResult(uuid: string): Props["message"] {
  return {
    message: { content: [{ content: "done", tool_use_id: "tool-1", type: "tool_result" }] },
    type: "user",
    uuid,
  } as Props["message"];
}

function groupedMessage(
  uuid: string,
  ids: string[],
  toolName = "Agent",
): Props["message"] {
  return {
    displayMessage: assistant(`${uuid}-display`, [textBlock("grouped display")]),
    messages: ids.map(id => assistant(`${uuid}-${id}`, [toolUseBlock(id, toolName)])),
    toolName,
    type: "grouped_tool_use",
    uuid,
  } as Props["message"];
}

function collapsedMessage(
  uuid: string,
  ids: string[],
  display: Props["message"] = assistant(`${uuid}-display`, [textBlock("collapsed display")]),
): Props["message"] {
  return {
    displayMessage: display,
    messages: [],
    toolUseIds: ids,
    type: "collapsed_read_search",
    uuid,
  } as Props["message"];
}

function baseLookups(overrides: Record<string, unknown> = {}): Props["lookups"] {
  return {
    erroredToolUseIDs: new Set<string>(),
    resolvedToolUseIDs: new Set<string>(),
    ...overrides,
  } as Props["lookups"];
}

function baseProps(message: Props["message"], overrides: Partial<Props> = {}): Props {
  return {
    canAnimate: true,
    columns: 44,
    commands: [],
    hasContentAfter: false,
    inProgressToolUseIDs: new Set<string>(),
    isLoading: false,
    isUserContinuation: false,
    lastThinkingBlockId: null,
    latestBashOutputUUID: null,
    lookups: baseLookups(),
    message,
    screen: "prompt",
    streamingToolUseIDs: new Set<string>(),
    tools: [] as never,
    verbose: false,
    ...overrides,
  };
}

async function renderRow(props: Props): Promise<{
  dispose: () => Promise<void>;
  output: () => string;
}> {
  let output = "";
  const { stdin, stdout } = createStreams();
  stdout.on("data", chunk => {
    output += chunk.toString();
  });
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  root.render(<MessageRow {...props} />);
  await sleep();
  return {
    dispose: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    },
    output: () => stripAnsi(output),
  };
}

describe("MessageRow helpers", () => {
  beforeEach(() => {
    harness.reset();
  });

  test("finds only non-skippable content after an index", () => {
    harness.collapsibleTools.add("Read");
    const messages = [
      collapsedMessage("current", ["read-live"]),
      assistant("thinking", [{ type: "thinking" }]),
      { type: "system", uuid: "system" },
      { type: "attachment", uuid: "attachment" },
      userToolResult("tool-result"),
      assistant("collapsed-read-tool", [toolUseBlock("read-1", "Read")]),
      assistant("streaming-tool", [toolUseBlock("stream-1", "Agent")]),
      groupedMessage("grouped-collapsible", ["read-2"], "Read"),
      groupedMessage("grouped-real", ["agent-2"], "Agent"),
    ] as Props["message"][];

    expect(
      hasContentAfterIndex(messages, 0, [] as never, new Set(["stream-1"])),
    ).toBe(true);
    expect(
      hasContentAfterIndex(messages.slice(0, -1), 0, [] as never, new Set(["stream-1"])),
    ).toBe(false);
    expect(
      hasContentAfterIndex(
        [...messages.slice(0, -1), assistant("text", [textBlock("done")])],
        0,
        [] as never,
        new Set(["stream-1"]),
      ),
    ).toBe(true);
  });

  test("detects streaming and resolved tool state across row variants", () => {
    const normal = assistant("normal", [toolUseBlock("tool-normal")]);
    const grouped = groupedMessage("grouped", ["tool-a", "tool-b"]);
    const collapsed = collapsedMessage("collapsed", ["tool-c", "tool-d"]);
    const serverTool = assistant("server", [{ id: "server-tool", type: "server_tool_use" }]);

    expect(isMessageStreaming(normal, new Set(["tool-normal"]))).toBe(true);
    expect(isMessageStreaming(grouped, new Set(["tool-b"]))).toBe(true);
    expect(isMessageStreaming(collapsed, new Set(["tool-d"]))).toBe(true);
    expect(isMessageStreaming(assistant("text", [textBlock()]), new Set(["x"]))).toBe(false);

    expect(allToolsResolved(normal, new Set(["tool-normal"]))).toBe(true);
    expect(allToolsResolved(grouped, new Set(["tool-a", "tool-b"]))).toBe(true);
    expect(allToolsResolved(collapsed, new Set(["tool-c", "tool-d"]))).toBe(true);
    expect(allToolsResolved(serverTool, new Set(["server-tool"]))).toBe(true);
    expect(allToolsResolved(grouped, new Set(["tool-a"]))).toBe(false);
    expect(allToolsResolved(assistant("text", [textBlock()]), new Set())).toBe(true);
  });

  test("memo comparator re-renders for dynamic rows and skips static rows", () => {
    const message = assistant("memo", [toolUseBlock("memo-tool")]);
    const staticProps = baseProps(message, {
      latestBashOutputUUID: "other",
      lookups: baseLookups({ resolvedToolUseIDs: new Set(["memo-tool"]) }),
    });

    expect(areMessageRowPropsEqual(staticProps, { ...staticProps })).toBe(true);
    expect(
      areMessageRowPropsEqual(staticProps, {
        ...staticProps,
        columns: staticProps.columns + 1,
      }),
    ).toBe(false);
    expect(
      areMessageRowPropsEqual(staticProps, {
        ...staticProps,
        screen: "transcript",
      }),
    ).toBe(false);
    expect(
      areMessageRowPropsEqual(staticProps, {
        ...staticProps,
        verbose: !staticProps.verbose,
      }),
    ).toBe(false);
    expect(
      areMessageRowPropsEqual(staticProps, {
        ...staticProps,
        latestBashOutputUUID: message.uuid,
      }),
    ).toBe(false);
    expect(
      areMessageRowPropsEqual(
        { ...staticProps, streamingToolUseIDs: new Set(["memo-tool"]) },
        staticProps,
      ),
    ).toBe(false);
    expect(
      areMessageRowPropsEqual(
        {
          ...staticProps,
          lookups: baseLookups({ resolvedToolUseIDs: new Set<string>() }),
        },
        staticProps,
      ),
    ).toBe(false);

    const thinking = assistant("thinking-memo", [{ type: "thinking" }]);
    const thinkingProps = baseProps(thinking);
    expect(
      areMessageRowPropsEqual(thinkingProps, {
        ...thinkingProps,
        lastThinkingBlockId: "new-thinking",
      }),
    ).toBe(false);

    const collapsed = baseProps(collapsedMessage("collapsed-memo", ["tool-1"]), {
      lookups: baseLookups({ resolvedToolUseIDs: new Set(["tool-1"]) }),
      screen: "prompt",
    });
    expect(areMessageRowPropsEqual(collapsed, collapsed)).toBe(false);
  });
});

describe("MessageRow rendering", () => {
  beforeEach(() => {
    harness.reset();
  });

  test("passes prompt row state to the message renderer", async () => {
    const message = assistant("assistant-live", [toolUseBlock("tool-live")]);
    harness.staticMessages.add(message.uuid);
    const rendered = await renderRow(
      baseProps(message, {
        inProgressToolUseIDs: new Set(["tool-live"]),
        isUserContinuation: true,
        lookups: baseLookups({
          progress: { [message.uuid]: ["first", "second"] },
          resolvedToolUseIDs: new Set(["tool-live"]),
          siblings: { [message.uuid]: ["tool-sibling"] },
        }),
      }),
    );

    try {
      expect(rendered.output()).toContain("Message:assistant-live:assistant:true:true:false:44");
      const call = harness.calls.find(item => item.name === "Message");
      expect(call?.props).toMatchObject({
        addMargin: true,
        containerWidth: 44,
        isActiveCollapsedGroup: false,
        isStatic: true,
        isTranscriptMode: false,
        isUserContinuation: true,
        progressMessagesForMessage: ["first", "second"],
        shouldAnimate: true,
        shouldShowDot: true,
      });
    } finally {
      await rendered.dispose();
    }
  });

  test("renders transcript metadata and lets metadata rows own width", async () => {
    const message = assistant(
      "assistant-transcript",
      [textBlock("with metadata")],
      { timestamp: "2026-05-20T00:00:00.000Z", model: "grok-4.3" },
    );
    const rendered = await renderRow(
      baseProps(message, {
        columns: 60,
        lookups: baseLookups(),
        screen: "transcript",
      }),
    );

    try {
      const output = rendered.output();
      expect(output).toContain("Timestamp:assistant-transcript");
      expect(output).toContain("Model:assistant-transcript");
      expect(output).toContain("Message:assistant-transcript:assistant:true:false:false:none");
      expect(harness.calls.find(item => item.name === "Message")?.props).toMatchObject({
        addMargin: false,
        containerWidth: undefined,
        isTranscriptMode: true,
      });
    } finally {
      await rendered.dispose();
    }
  });

  test("normalizes grouped and collapsed rows before rendering", async () => {
    const grouped = groupedMessage("grouped-row", ["tool-a", "tool-live"]);
    const collapsed = collapsedMessage("collapsed-row", ["read-live"]);

    const groupedRender = await renderRow(
      baseProps(grouped, {
        inProgressToolUseIDs: new Set(["tool-live"]),
      }),
    );
    const collapsedRender = await renderRow(
      baseProps(collapsed, {
        inProgressToolUseIDs: new Set(["read-live"]),
        isLoading: true,
      }),
    );

    try {
      expect(groupedRender.output()).toContain("Message:grouped-row:grouped_tool_use:true:false:false:44");
      expect(collapsedRender.output()).toContain("Message:collapsed-row:collapsed_read_search:true:false:true:44");
      const groupedCall = harness.calls.find(
        item =>
          item.name === "Message" &&
          (item.props.message as { uuid: string }).uuid === "grouped-row",
      );
      const collapsedCall = harness.calls.find(
        item =>
          item.name === "Message" &&
          (item.props.message as { uuid: string }).uuid === "collapsed-row",
      );
      expect(groupedCall?.props).toMatchObject({
        isActiveCollapsedGroup: false,
        progressMessagesForMessage: [],
        shouldAnimate: true,
      });
      expect(collapsedCall?.props).toMatchObject({
        isActiveCollapsedGroup: true,
        progressMessagesForMessage: [],
        shouldAnimate: true,
      });
    } finally {
      await groupedRender.dispose();
      await collapsedRender.dispose();
    }
  });
});
