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

vi.mock("../../../src/utils/collapseReadSearch.js", () => ({
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

vi.mock("../../../src/utils/messages.js", () => ({
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
    message?: { content?: Array<{ id?: string }> };
    toolUseID?: string;
  }) => message.toolUseID ?? message.message?.content?.[0]?.id,
}));

vi.mock("../../../src/tui/components/Message.js", async () => {
  const ReactModule = await import("react");
  const { default: Text } = await vi.importActual<
    typeof import("../../../src/tui/ink/components/Text.js")
  >("../../../src/tui/ink/components/Text.js");

  return {
    hasThinkingContent: (message: {
      message?: { content?: Array<{ type?: string }> };
    }) =>
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
        [
          "row",
          message.uuid,
          message.type,
          String(props.shouldAnimate),
          String(props.isActiveCollapsedGroup),
          String(props.containerWidth ?? "none"),
          String(props.addMargin),
        ].join(":"),
      );
    },
  };
});

vi.mock("../../../src/tui/components/Messages.js", () => ({
  shouldRenderStatically: (message: { uuid: string }) =>
    harness.staticMessages.has(message.uuid),
}));

vi.mock("../../../src/tui/components/MessageModel.js", async () => {
  const ReactModule = await import("react");
  const { default: Text } = await vi.importActual<
    typeof import("../../../src/tui/ink/components/Text.js")
  >("../../../src/tui/ink/components/Text.js");

  return {
    MessageModel: ({ message }: { readonly message: { uuid: string } }) =>
      ReactModule.createElement(Text, null, `model:${message.uuid}`),
  };
});

vi.mock("../../../src/tui/components/MessageTimestamp.js", async () => {
  const ReactModule = await import("react");
  const { default: Text } = await vi.importActual<
    typeof import("../../../src/tui/ink/components/Text.js")
  >("../../../src/tui/ink/components/Text.js");

  return {
    MessageTimestamp: ({ message }: { readonly message: { uuid: string } }) =>
      ReactModule.createElement(Text, null, `time:${message.uuid}`),
  };
});

vi.mock("../../../src/tui/components/OffscreenFreeze.js", async () => {
  const ReactModule = await import("react");

  return {
    OffscreenFreeze: ({ children }: { readonly children?: React.ReactNode }) => {
      harness.calls.push({ name: "OffscreenFreeze", props: {} });
      return ReactModule.createElement(ReactModule.Fragment, null, children);
    },
  };
});

import { MessageRow, type Props } from "../../../src/tui/components/MessageRow.js";
import { createRoot } from "../../../src/tui/ink/root.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function createStreams(): {
  readonly stdin: TestStdin;
  readonly stdout: PassThrough;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

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

function assistant(
  uuid: string,
  content: Array<Record<string, unknown>>,
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

function textBlock(text = "hello"): Record<string, unknown> {
  return { text, type: "text" };
}

function toolUseBlock(id: string, name = "Agent"): Record<string, unknown> {
  return { id, input: {}, name, type: "tool_use" };
}

function groupedMessage(
  uuid: string,
  ids: string[],
  toolName = "Agent",
): Props["message"] {
  return {
    displayMessage: assistant(`${uuid}-display`, [textBlock("grouped")]),
    messages: ids.map(id => assistant(`${uuid}-${id}`, [toolUseBlock(id, toolName)])),
    toolName,
    type: "grouped_tool_use",
    uuid,
  } as Props["message"];
}

function collapsedMessage(
  uuid: string,
  ids: string[],
  displayMessage = assistant(`${uuid}-display`, [textBlock("collapsed")]),
): Props["message"] {
  return {
    displayMessage,
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
    columns: 38,
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
  readonly output: () => string;
  readonly unmount: () => Promise<void>;
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
    output: () => stripAnsi(output),
    unmount: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    },
  };
}

describe("MessageRow coverage swarm row 121", () => {
  beforeEach(() => {
    harness.reset();
  });

  test("passes false animation state for disabled and inactive tool rows", async () => {
    const staticText = assistant("static-text", [textBlock()]);
    harness.staticMessages.add(staticText.uuid);

    const disabledAnimation = await renderRow(
      baseProps(staticText, {
        canAnimate: false,
        lookups: baseLookups({ progress: { [staticText.uuid]: ["queued"] } }),
      }),
    );
    const inactiveTool = await renderRow(
      baseProps(assistant("inactive-tool", [toolUseBlock("tool-id")]), {
        inProgressToolUseIDs: new Set(["other-tool"]),
      }),
    );

    try {
      expect(disabledAnimation.output()).toContain(
        "row:static-text:assistant:false:false:38:true",
      );
      expect(inactiveTool.output()).toContain(
        "row:inactive-tool:assistant:false:false:38:true",
      );
      expect(
        harness.calls.find(
          call =>
            call.name === "Message" &&
            (call.props.message as { uuid: string }).uuid === "static-text",
        )?.props,
      ).toMatchObject({
        isStatic: true,
        progressMessagesForMessage: ["queued"],
        shouldAnimate: false,
      });
    } finally {
      await disabledAnimation.unmount();
      await inactiveTool.unmount();
    }
  });

  test("distinguishes grouped and collapsed inactive states from loading-only collapsed activity", async () => {
    const grouped = await renderRow(baseProps(groupedMessage("grouped-idle", ["group-tool"])));
    const collapsedLoading = await renderRow(
      baseProps(collapsedMessage("collapsed-loading", ["read-tool"]), {
        isLoading: true,
      }),
    );
    const collapsedAfterContent = await renderRow(
      baseProps(collapsedMessage("collapsed-after", ["read-tool"]), {
        hasContentAfter: true,
        isLoading: true,
      }),
    );

    try {
      expect(grouped.output()).toContain(
        "row:grouped-idle:grouped_tool_use:false:false:38:true",
      );
      expect(collapsedLoading.output()).toContain(
        "row:collapsed-loading:collapsed_read_search:false:true:38:true",
      );
      expect(collapsedAfterContent.output()).toContain(
        "row:collapsed-after:collapsed_read_search:false:false:38:true",
      );
      expect(
        harness.calls
          .filter(call => call.name === "Message")
          .map(call => call.props.progressMessagesForMessage),
      ).toEqual([[], [], []]);
    } finally {
      await grouped.unmount();
      await collapsedLoading.unmount();
      await collapsedAfterContent.unmount();
    }
  });

  test("uses normal row layout for transcript assistant rows without text metadata", async () => {
    const displayMessage = assistant(
      "non-text-display",
      [{ id: "server-id", name: "search", type: "server_tool_use" }],
      { model: "gpt-test", timestamp: "2026-05-20T00:00:00.000Z" },
    );
    const rendered = await renderRow(
      baseProps(collapsedMessage("collapsed-transcript", ["read-tool"], displayMessage), {
        columns: 62,
        screen: "transcript",
      }),
    );

    try {
      const output = rendered.output();
      expect(output).toContain(
        "row:collapsed-transcript:collapsed_read_search:false:false:62:true",
      );
      expect(output).not.toContain("time:non-text-display");
      expect(output).not.toContain("model:non-text-display");
      expect(
        harness.calls.find(call => call.name === "Message")?.props,
      ).toMatchObject({
        addMargin: true,
        containerWidth: 62,
        isTranscriptMode: true,
      });
    } finally {
      await rendered.unmount();
    }
  });
});
