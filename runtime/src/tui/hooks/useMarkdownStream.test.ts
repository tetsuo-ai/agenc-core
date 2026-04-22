/**
 * Wave 2 useMarkdownStream hook tests.
 *
 * The hook loads the watch markdown-stream collector lazily and renders
 * chunks via a React `useEffect`. We don't exercise the dynamic-import
 * path here (it would pull in markdown-it for real); instead we inject a
 * stub collector via `__setMarkdownStreamModuleForTests()` and drive the
 * hook through a tiny Ink-hosted Consumer component.
 *
 * The fallback branch is exercised by the first tests, which force the
 * loader into the "failed" state and assert the naive concat path.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, describe, expect, test } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import {
  STREAM_DONE_CHUNK,
  __resetMarkdownStreamModuleForTests,
  __setMarkdownStreamModuleForTests,
  useMarkdownStream,
} from "./useMarkdownStream.js";

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
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

/** Minimal collector stub that just records deltas and returns them. */
function makeStubCollector() {
  const deltas: string[] = [];
  let cleared = 0;
  return {
    collector: {
      clear() {
        cleared += 1;
        deltas.length = 0;
      },
      pushDelta(d: string) {
        deltas.push(d);
      },
      snapshot() {
        return deltas.map((text) => ({ text }));
      },
      finalizeAndDrain() {
        return deltas.map((text) => ({ text }));
      },
    },
    state: {
      get cleared() {
        return cleared;
      },
      deltas,
    },
  };
}

describe("useMarkdownStream", () => {
  afterEach(() => {
    __resetMarkdownStreamModuleForTests();
  });

  test("loads the real watch markdown module path when the chain is intact", async () => {
    let observed: { rendered: string; isComplete: boolean } | null = null;
    function Consumer({ chunks }: { chunks: readonly string[] }): null {
      const res = useMarkdownStream(chunks);
      observed = { rendered: res.rendered, isComplete: res.isComplete };
      return null;
    }
    const { unmount } = await mount(
      React.createElement(Consumer, {
        chunks: ["See [docs](https://example.com)"],
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(observed).toEqual({
      rendered: "See docs (https://example.com)",
      isComplete: false,
    });
    unmount();
  });

  test("renders the fallback concat when the module is marked failed", async () => {
    __setMarkdownStreamModuleForTests(null, "test-fail");
    let observed: { rendered: string; isComplete: boolean } | null = null;
    function Consumer({ chunks }: { chunks: readonly string[] }): null {
      const res = useMarkdownStream(chunks);
      observed = { rendered: res.rendered, isComplete: res.isComplete };
      return null;
    }
    const { unmount } = await mount(
      React.createElement(Consumer, { chunks: ["hello, ", "world"] }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(observed!.rendered).toBe("hello, world");
    expect(observed!.isComplete).toBe(false);
    unmount();
  });

  test("marks isComplete=true when the sentinel chunk is appended (fallback path)", async () => {
    __setMarkdownStreamModuleForTests(null, "test-fail");
    let observed: { rendered: string; isComplete: boolean } | null = null;
    function Consumer({ chunks }: { chunks: readonly string[] }): null {
      const res = useMarkdownStream(chunks);
      observed = { rendered: res.rendered, isComplete: res.isComplete };
      return null;
    }
    const { unmount } = await mount(
      React.createElement(Consumer, { chunks: ["hi", STREAM_DONE_CHUNK] }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(observed!.isComplete).toBe(true);
    expect(observed!.rendered).toBe("hi");
    unmount();
  });

  test("pushes each new chunk into the injected collector", async () => {
    const { collector, state } = makeStubCollector();
    __setMarkdownStreamModuleForTests(
      { createMarkdownStreamCollector: () => collector },
      null,
    );
    function Consumer({ chunks }: { chunks: readonly string[] }): null {
      useMarkdownStream(chunks);
      return null;
    }
    const { unmount } = await mount(
      React.createElement(Consumer, { chunks: ["a", "b", "c"] }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(state.deltas).toEqual(["a", "b", "c"]);
    unmount();
  });

  test("finalizes the collector when the sentinel chunk is seen", async () => {
    const { collector, state } = makeStubCollector();
    __setMarkdownStreamModuleForTests(
      { createMarkdownStreamCollector: () => collector },
      null,
    );
    let observed: { isComplete: boolean } | null = null;
    function Consumer({ chunks }: { chunks: readonly string[] }): null {
      const res = useMarkdownStream(chunks);
      observed = { isComplete: res.isComplete };
      return null;
    }
    const { unmount } = await mount(
      React.createElement(Consumer, {
        chunks: ["a", "b", STREAM_DONE_CHUNK],
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(observed!.isComplete).toBe(true);
    expect(state.deltas).toEqual(["a", "b"]);
    unmount();
  });
});
