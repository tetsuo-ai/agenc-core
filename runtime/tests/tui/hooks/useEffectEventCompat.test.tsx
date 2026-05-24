import { PassThrough } from "node:stream";

import React, { useLayoutEffect } from "react";
import { afterEach, describe, expect, test } from "vitest";

import { createRoot } from "../ink/root.js";
import { useEffectEventCompat } from "./useEffectEventCompat.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

const cleanupRoots: Array<() => void> = [];

function createStreams(): { readonly stdin: TestStdin; readonly stdout: PassThrough } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  return { stdin, stdout };
}

async function sleep(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function Child({
  onLayout,
}: {
  readonly onLayout: () => void;
}): null {
  useLayoutEffect(() => {
    onLayout();
  });
  return null;
}

function Harness({
  identities,
  label,
  snapshots,
}: {
  readonly identities?: Array<() => void>;
  readonly label: string;
  readonly snapshots: string[];
}): React.ReactElement {
  const onLayout = useEffectEventCompat(() => {
    snapshots.push(label);
  });
  useLayoutEffect(() => {
    identities?.push(onLayout);
  });
  return <Child onLayout={onLayout} />;
}

async function createHarness(snapshots: string[], identities?: Array<() => void>): Promise<{
  readonly render: (label: string) => Promise<void>;
}> {
  const { stdin, stdout } = createStreams();
  const root = await createRoot({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  });
  cleanupRoots.push(() => {
    root.unmount();
    stdin.end();
    stdout.end();
  });

  return {
    render: async (label: string) => {
      root.render(<Harness identities={identities} label={label} snapshots={snapshots} />);
      await sleep();
    },
  };
}

afterEach(() => {
  for (const cleanup of cleanupRoots.splice(0)) cleanup();
});

describe("useEffectEventCompat", () => {
  test("stable callbacks see the latest render state during descendant layout effects", async () => {
    const snapshots: string[] = [];
    const identities: Array<() => void> = [];
    const { render } = await createHarness(snapshots, identities);

    await render("first");
    await render("second");

    expect(snapshots).toEqual(["first", "second"]);
    expect(identities).toHaveLength(2);
    expect(identities[1]).toBe(identities[0]);
  });
});
