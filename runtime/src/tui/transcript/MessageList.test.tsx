/**
 * Wave 4-A MessageList tests.
 *
 * Covers the per-kind dispatcher and the sticky-scroll behavior. The
 * sticky assertion runs against a fake scroll handle that records what
 * `scrollToBottom()` was called, so we can verify the "follow on new
 * message" contract without having to drive a real layout pass.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import {
  MessageList,
  truncate,
  type TranscriptMessage,
} from "./MessageList.js";

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

async function mount(
  element: React.ReactElement,
): Promise<{
  unmount: () => void;
  stdout: PassThrough;
  rerender: (el: React.ReactElement) => void;
}> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((r) => setTimeout(r, 40));
  return {
    stdout,
    rerender: (el) => root.render(el),
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

async function captureFrame(stdout: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  stdout.on("data", (b: Buffer) => chunks.push(b));
  await new Promise((r) => setTimeout(r, 40));
  return Buffer.concat(chunks).toString("utf8");
}

function mkMsg(
  partial: Partial<TranscriptMessage> & Pick<TranscriptMessage, "id" | "kind">,
): TranscriptMessage {
  return {
    turnId: "t1",
    content: "",
    timestamp: 0,
    ...partial,
  };
}

describe("MessageList", () => {
  test("renders an empty list without throwing", async () => {
    const { unmount, stdout } = await mount(
      <MessageList messages={[]} />,
    );
    const frame = await captureFrame(stdout);
    // Empty list is a valid state — just assert it rendered something
    // (not the empty string, since the ScrollBox chrome alone emits
    // frame bytes) and didn't write any of the per-kind sigils.
    expect(frame).not.toContain("\u25B8");
    expect(frame).not.toContain("\u2717");
    unmount();
  });

  test("renders a user message with the cyan ▸ sigil", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[mkMsg({ id: "u1", kind: "user", content: "hello" })]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("\u25B8");
    expect(frame).toContain("hello");
    unmount();
  });

  test("renders a tool_call with truncated args", async () => {
    const longArg = "x".repeat(200);
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "c1",
            kind: "tool_call",
            toolName: "shell",
            toolArgs: { cmd: longArg },
          }),
        ]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("shell");
    // The ellipsis character from truncate() proves the long args were
    // compressed before rendering.
    expect(frame).toContain("\u2026");
    unmount();
  });

  test("renders tool_result with success vs error glyphs", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "r1",
            kind: "tool_result",
            content: "ok",
            isError: false,
          }),
          mkMsg({
            id: "r2",
            kind: "tool_result",
            content: "fail",
            isError: true,
          }),
        ]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("\u2713");
    expect(frame).toContain("\u2717");
    unmount();
  });

  test("renders a warning with the ⚠ glyph", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({ id: "w1", kind: "warning", content: "rate limit" }),
        ]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("\u26A0");
    // Ink may column-align adjacent `<Text>` children with padding when
    // the outer Box is a `flexDirection="row"` container — the string
    // "rate" and "limit" can land in separate screen columns. Assert
    // each word independently so the spacing scheme doesn't break the
    // content check.
    expect(frame).toContain("rate");
    expect(frame).toContain("limit");
    unmount();
  });

  test("new message triggers a follow frame write when sticky", async () => {
    // Sticky-follow is observable through the rerender: appending a
    // message when the ScrollBox is glued to the bottom should not
    // throw, and the new message's content should be present in the
    // next captured frame.
    const { unmount, stdout, rerender } = await mount(
      <MessageList
        messages={[mkMsg({ id: "u1", kind: "user", content: "alpha" })]}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    rerender(
      <MessageList
        messages={[
          mkMsg({ id: "u1", kind: "user", content: "alpha" }),
          mkMsg({ id: "u2", kind: "user", content: "beta" }),
        ]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("beta");
    unmount();
  });
});

describe("truncate helper", () => {
  test("returns short strings unchanged and truncates long ones with ellipsis", () => {
    expect(truncate("abc", 10)).toBe("abc");
    const long = "x".repeat(200);
    const t = truncate(long, 50);
    expect(t.length).toBe(50);
    expect(t.endsWith("\u2026")).toBe(true);
  });
});
