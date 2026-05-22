import { PassThrough } from "node:stream";

import React, { useLayoutEffect, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { PrBadge } from "../../../src/tui/components/PrBadge.js";
import type { DOMElement } from "../../../src/tui/ink/dom.js";
import instances from "../../../src/tui/ink/instances.js";
import { createRoot } from "../../../src/tui/ink/root.js";
import { squashTextNodesToSegments } from "../../../src/tui/ink/squash-text-nodes.js";
import type { PrReviewState } from "../../../src/utils/ghPrStatus.js";
import { getTheme } from "../../../src/utils/theme.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type TestStdout = PassThrough & {
  columns: number;
  isTTY: boolean;
  rows: number;
};

const previousForceHyperlink = process.env.FORCE_HYPERLINK;

afterEach(() => {
  if (previousForceHyperlink === undefined) {
    delete process.env.FORCE_HYPERLINK;
  } else {
    process.env.FORCE_HYPERLINK = previousForceHyperlink;
  }
});

function createStreams(): {
  readonly stdin: TestStdin;
  readonly stdout: TestStdout;
} {
  const stdin = new PassThrough() as TestStdin;
  const stdout = new PassThrough() as TestStdout;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};

  stdout.columns = 120;
  stdout.rows = 24;
  stdout.isTTY = true;
  stdout.resume();

  return { stdin, stdout };
}

function getRootNode(stdout: TestStdout): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream);
  if (!instance?.rootNode) {
    throw new Error("Ink root node not found");
  }
  return instance.rootNode;
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function renderSegments(
  node: React.ReactNode,
): Promise<
  Array<{
    readonly hyperlink?: string;
    readonly styles: Record<string, unknown>;
    readonly text: string;
  }>
> {
  const { stdin, stdout } = createStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  try {
    root.render(node);
    await sleep();
    return squashTextNodesToSegments(getRootNode(stdout));
  } finally {
    root.unmount();
    stdin.end();
    stdout.end();
    await sleep();
  }
}

function RerenderStableBadge({
  onRender,
}: {
  readonly onRender: (count: number) => void;
}) {
  const [count, setCount] = useState(0);

  useLayoutEffect(() => {
    onRender(count);
    if (count === 0) setCount(1);
  }, [count, onRender]);

  return (
    <PrBadge
      number={118}
      reviewState="approved"
      url="https://example.test/pull/118"
    />
  );
}

describe("PrBadge coverage swarm 118", () => {
  test("maps review states onto colored linked PR labels", async () => {
    process.env.FORCE_HYPERLINK = "1";
    const theme = getTheme("dark");
    const cases: Array<{
      readonly color: "error" | "merged" | "success" | "warning" | undefined;
      readonly number: number;
      readonly state?: PrReviewState;
    }> = [
      { color: "success", number: 118, state: "approved" },
      { color: "error", number: 119, state: "changes_requested" },
      { color: "warning", number: 120, state: "pending" },
      { color: "merged", number: 121, state: "merged" },
      { color: undefined, number: 122 },
    ];

    const segments = await renderSegments(
      <>
        {cases.map(({ number, state }) => (
          <PrBadge
            key={number}
            number={number}
            reviewState={state}
            url={`https://example.test/pull/${number}`}
          />
        ))}
      </>,
    );

    expect(segments.map(segment => segment.text).join("")).toContain(
      "PR #118PR #119PR #120PR #121PR #122",
    );

    for (const { color, number } of cases) {
      const url = `https://example.test/pull/${number}`;
      const numberSegments = segments.filter(
        segment => segment.hyperlink === url,
      );

      expect(numberSegments.map(segment => segment.text).join("")).toBe(
        `#${number}`,
      );
      expect(numberSegments[0]?.styles).toMatchObject({
        underline: true,
      });
      expect(numberSegments[1]?.styles).toMatchObject(
        numberSegments[0]?.styles ?? {},
      );

      if (color === undefined) {
        expect(numberSegments[0]?.styles.color).toBe(theme.inactive);
      } else {
        expect(numberSegments[0]?.styles.color).toBe(theme[color]);
      }
    }

    expect(
      segments.filter(segment => segment.text === "PR").map(segment => ({
        color: segment.styles.color,
      })),
    ).toEqual(cases.map(() => ({ color: theme.inactive })));
  });

  test("keeps bold fallback styling and reuses cached render branches", async () => {
    process.env.FORCE_HYPERLINK = "1";
    const onRender = vi.fn();

    const segments = await renderSegments(
      <>
        <RerenderStableBadge onRender={onRender} />
        <PrBadge
          bold={true}
          number={123}
          url="https://example.test/pull/123"
        />
      </>,
    );

    expect(onRender).toHaveBeenCalledWith(0);
    expect(onRender).toHaveBeenCalledWith(1);

    const rerendered = segments.filter(
      segment => segment.hyperlink === "https://example.test/pull/118",
    );
    expect(rerendered.map(segment => segment.text).join("")).toBe("#118");
    expect(rerendered[0]?.styles).toMatchObject({
      color: getTheme("dark").success,
      underline: true,
    });

    const boldFallback = segments.filter(
      segment => segment.hyperlink === "https://example.test/pull/123",
    );
    expect(boldFallback.map(segment => segment.text).join("")).toBe("#123");
    expect(boldFallback[0]?.styles).toMatchObject({
      bold: true,
      underline: true,
    });
    expect(boldFallback[0]?.styles.color).toBeUndefined();

    const labels = segments.filter(segment => segment.text === "PR");
    expect(labels.at(-1)?.styles.color).toBeUndefined();
  });
});
