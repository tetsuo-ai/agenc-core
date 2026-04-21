/**
 * Wave 4-B StatusLineConfig tests.
 *
 * Exercises the pure resolver and the React component. The git branch
 * resolver is tested against a fake `GitBranchReader` so we never
 * spawn a real git subprocess in the unit tests.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import type { DOMElement } from "../ink/dom.js";
import {
  StatusLineConfig,
  resolveStatusItem,
  __resetGitCacheForTesting,
  __setGitBranchReaderForTesting,
  type GitBranchReader,
} from "./StatusLineConfig.js";

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
  (stdout as unknown as { columns: number }).columns = 120;
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
  await new Promise((r) => setTimeout(r, 30));
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

function collectText(node: DOMElement): string {
  const parts: string[] = [];
  const walk = (n: DOMElement): void => {
    for (const child of n.childNodes) {
      if (child.nodeName === "#text") {
        parts.push((child as unknown as { nodeValue: string }).nodeValue ?? "");
      } else {
        walk(child as DOMElement);
      }
    }
  };
  walk(node);
  return parts.join("");
}

function getRoot(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { rootNode?: DOMElement }
    | undefined;
  if (!instance?.rootNode) throw new Error("Ink instance root missing");
  return instance.rootNode;
}

describe("StatusLineConfig", () => {
  let restoreReader: GitBranchReader | null = null;

  beforeEach(() => {
    __resetGitCacheForTesting();
  });

  afterEach(() => {
    if (restoreReader !== null) {
      __setGitBranchReaderForTesting(restoreReader);
      restoreReader = null;
    }
    __resetGitCacheForTesting();
    vi.restoreAllMocks();
  });

  test("resolveStatusItem('model') returns session.model", async () => {
    const out = await resolveStatusItem("model", {
      session: { model: "grok-4" },
      cwd: "/tmp",
    });
    expect(out).toBe("grok-4");
  });

  test("resolveStatusItem('mode') returns session.mode", async () => {
    const out = await resolveStatusItem("mode", {
      session: { mode: "acceptEdits" },
      cwd: "/tmp",
    });
    expect(out).toBe("acceptEdits");
  });

  test("resolveStatusItem('cwd') returns the basename of cwd", async () => {
    const out = await resolveStatusItem("cwd", {
      session: {},
      cwd: "/home/tetsuo/workspace/project",
    });
    expect(out).toBe("project");
  });

  test("resolveStatusItem('git') returns '' when the reader throws", async () => {
    const original = __setGitBranchReaderForTesting(async () => {
      throw new Error("not a git repo");
    });
    restoreReader = original;
    const out = await resolveStatusItem("git", {
      session: {},
      cwd: "/some/non/git/dir",
    });
    expect(out).toBe("");
  });

  test("resolveStatusItem('git') caches results within 2s", async () => {
    const calls: string[] = [];
    const original = __setGitBranchReaderForTesting(async (cwd: string) => {
      calls.push(cwd);
      return "main";
    });
    restoreReader = original;

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);
    const first = await resolveStatusItem("git", {
      session: {},
      cwd: "/repo",
    });
    expect(first).toBe("main");
    expect(calls).toHaveLength(1);

    // 1.5 s later — still inside the 2 s TTL.
    nowSpy.mockReturnValue(2_500);
    const second = await resolveStatusItem("git", {
      session: {},
      cwd: "/repo",
    });
    expect(second).toBe("main");
    expect(calls).toHaveLength(1);

    // 3 s after first call — cache expired, reader is hit again.
    nowSpy.mockReturnValue(4_000);
    const third = await resolveStatusItem("git", {
      session: {},
      cwd: "/repo",
    });
    expect(third).toBe("main");
    expect(calls).toHaveLength(2);
  });

  test("component renders items in configured order", async () => {
    const original = __setGitBranchReaderForTesting(async () => "feature/x");
    restoreReader = original;

    const { stdout, unmount } = await mount(
      <StatusLineConfig
        items={["model", "mode", "cwd"]}
        session={{ model: "grok-4", mode: "plan" }}
        cwd="/home/user/myproject"
      />,
    );
    await new Promise((r) => setTimeout(r, 60));
    const text = collectText(getRoot(stdout));
    const modelIdx = text.indexOf("grok-4");
    const modeIdx = text.indexOf("plan");
    const cwdIdx = text.indexOf("myproject");
    expect(text).toContain("MODEL");
    expect(text).toContain("MODE");
    expect(text).toContain("CWD");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(modeIdx).toBeGreaterThan(modelIdx);
    expect(cwdIdx).toBeGreaterThan(modeIdx);
    unmount();
  });

  test("component renders context as a compact usage meter", async () => {
    const { stdout, unmount } = await mount(
      <StatusLineConfig
        items={["context", "tokens"]}
        session={{ contextPercent: 82, tokensUsed: 12_345 }}
        cwd="/home/user/myproject"
      />,
    );
    await new Promise((r) => setTimeout(r, 60));
    const text = collectText(getRoot(stdout));
    expect(text).toContain("CONTEXT");
    expect(text).toContain("82% [####-]");
    expect(text).toContain("TOKENS");
    expect(text).toContain("12.3k");
    unmount();
  });
});
