/**
 * PlanProgress tests (T12 Wave 4-C).
 *
 * Mounts `<PlanProgress>` under a real Ink root fed by PassThrough
 * streams so rendered text is reachable through the same `collectText`
 * helper used elsewhere in the Wave 2/3 tests.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import type { DOMElement, DOMNode } from "../ink/dom.js";
import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";

import { PlanProgress, type PlanEvent } from "./PlanProgress.js";

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
  stdout: PassThrough;
  unmount: () => void;
}> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((r) => setTimeout(r, 20));
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

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { rootNode?: DOMElement }
    | undefined;
  if (!instance?.rootNode) {
    throw new Error("Ink root not found in test harness");
  }
  return instance.rootNode;
}

function collectText(node: DOMNode): string {
  if (node.nodeName === "#text") {
    return node.nodeValue;
  }
  const parts: string[] = [];
  if ("childNodes" in node) {
    for (const child of node.childNodes) {
      parts.push(collectText(child));
    }
  }
  return parts.join("");
}

describe("<PlanProgress>", () => {
  test("empty events renders nothing visible", async () => {
    const { stdout, unmount } = await mount(<PlanProgress events={[]} />);
    const text = collectText(getRootNode(stdout));
    expect(text).toBe("");
    unmount();
  });

  test("one plan_started renders an Updated Plan header and checklist row", async () => {
    const events: PlanEvent[] = [
      {
        kind: "plan_started",
        planItemId: "turn-1-plan",
        title: "explore and fix",
        timestamp: 1,
      },
    ];
    const { stdout, unmount } = await mount(<PlanProgress events={events} />);
    const text = collectText(getRootNode(stdout));
    expect(text).toContain("Updated Plan");
    expect(text).toContain("explore and fix");
    unmount();
  });

  test("plan_delta appends detail lines for the matching planItemId", async () => {
    const events: PlanEvent[] = [
      {
        kind: "plan_started",
        planItemId: "turn-1-plan",
        title: "build",
        timestamp: 1,
      },
      {
        kind: "plan_delta",
        planItemId: "turn-1-plan",
        delta: "step A ",
        timestamp: 2,
      },
      {
        kind: "plan_delta",
        planItemId: "turn-1-plan",
        delta: "step B",
        timestamp: 3,
      },
    ];
    const { stdout, unmount } = await mount(<PlanProgress events={events} />);
    const text = collectText(getRootNode(stdout));
    expect(text).toContain("Updated Plan");
    expect(text).toContain("build");
    expect(text).toContain("step A step B");
    unmount();
  });

  test("plan_item_completed keeps the checklist and shows the final text", async () => {
    const events: PlanEvent[] = [
      {
        kind: "plan_started",
        planItemId: "turn-1-plan",
        title: "ship",
        timestamp: 1,
      },
      {
        kind: "plan_item_completed",
        planItemId: "turn-1-plan",
        finalText: "1. do X\n2. do Y",
        timestamp: 4,
      },
    ];
    const { stdout, unmount } = await mount(<PlanProgress events={events} />);
    const text = collectText(getRootNode(stdout));
    expect(text).toContain("Updated Plan");
    expect(text).toContain("\u2714");
    expect(text).toContain("1. do X");
    expect(text).toContain("2. do Y");
    unmount();
  });

  test("plan_exited keeps the history cell instead of a terminal marker widget", async () => {
    const events: PlanEvent[] = [
      {
        kind: "plan_started",
        planItemId: "turn-1-plan",
        title: "draft",
        timestamp: 1,
      },
      { kind: "plan_exited", timestamp: 5 },
    ];
    const { stdout, unmount } = await mount(<PlanProgress events={events} />);
    const text = collectText(getRootNode(stdout));
    expect(text).toContain("Updated Plan");
    expect(text).toContain("draft");
    expect(text).not.toContain("plan mode ended");
    unmount();
  });
});
