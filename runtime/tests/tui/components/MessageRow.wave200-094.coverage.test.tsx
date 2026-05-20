import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  messageCalls: 0,
  staticCalls: 0,
}));

vi.mock("../../utils/collapseReadSearch.js", () => ({
  getDisplayMessageFromCollapsed: (message: { displayMessage?: unknown }) =>
    message.displayMessage,
  getToolSearchOrReadInfo: () => ({ isCollapsible: false }),
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
    hasThinkingContent: () => false,
    Message: (props: Record<string, unknown>) => {
      harness.messageCalls++;
      const message = props.message as { uuid: string };
      const progress = props.progressMessagesForMessage as string[];
      return ReactModule.createElement(
        Text,
        null,
        `message:${message.uuid}:${String(props.shouldAnimate)}:${progress.join(",")}`,
      );
    },
  };
});

vi.mock("./MessageModel.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../ink.js");
  return {
    MessageModel: () => ReactModule.createElement(Text, null, "model"),
  };
});

vi.mock("./MessageTimestamp.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../ink.js");
  return {
    MessageTimestamp: () => ReactModule.createElement(Text, null, "time"),
  };
});

vi.mock("./Messages.js", () => ({
  shouldRenderStatically: () => {
    harness.staticCalls++;
    return false;
  },
}));

vi.mock("./OffscreenFreeze.js", async () => {
  const ReactModule = await import("react");
  return {
    OffscreenFreeze: ({ children }: { readonly children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import { createRoot } from "../ink/root.js";
import { MessageRow, type Props } from "./MessageRow.js";

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

async function sleep(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 25));
}

function toolMessage(): Props["message"] {
  return {
    message: {
      content: [
        {
          id: "tool-live",
          input: {},
          name: "Agent",
          type: "tool_use",
        },
      ],
    },
    type: "assistant",
    uuid: "cache-row",
  } as Props["message"];
}

function rowProps(message: Props["message"]): Props {
  return {
    canAnimate: true,
    columns: 52,
    commands: [],
    hasContentAfter: false,
    inProgressToolUseIDs: new Set(["tool-live"]),
    isLoading: false,
    isUserContinuation: false,
    lastThinkingBlockId: null,
    latestBashOutputUUID: null,
    lookups: {
      erroredToolUseIDs: new Set<string>(),
      progress: { [message.uuid]: ["queued"] },
      resolvedToolUseIDs: new Set<string>(),
    } as Props["lookups"],
    message,
    screen: "prompt",
    streamingToolUseIDs: new Set<string>(),
    tools: [] as never,
    verbose: false,
  };
}

describe("MessageRow wave 094 coverage", () => {
  beforeEach(() => {
    harness.messageCalls = 0;
    harness.staticCalls = 0;
  });

  test("rerenders unresolved tool rows without rebuilding stable child props", async () => {
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
    const props = rowProps(toolMessage());

    try {
      root.render(<MessageRow {...props} />);
      await sleep();
      root.render(<MessageRow {...props} />);
      await sleep();

      expect(stripAnsi(output)).toContain("message:cache-row:true:queued");
      expect(harness.staticCalls).toBe(1);
      expect(harness.messageCalls).toBe(1);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
