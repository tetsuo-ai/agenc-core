/**
 * Wave 4-B Banner component tests.
 *
 * The banner is a leaf component that renders through Ink's react
 * reconciler. We mount it inside a test Ink root with a PassThrough
 * stdout (same pattern used across the Wave 2 tests) and then walk the
 * DOM tree to inspect the rendered text/colour, rather than parsing the
 * ANSI frame.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import type { DOMElement } from "../ink/dom.js";
import {
  ClockContext,
  createClock,
  type Clock,
} from "../ink/components/ClockContext.js";
import { Banner } from "./Banner.js";
import { theme } from "../theme.js";

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
  getText: () => string;
}> {
  const { stdout, stdin } = createStreams();
  const chunks: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((r) => setTimeout(r, 30));
  return {
    stdout,
    getText: () => Buffer.concat(chunks).toString("utf8"),
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

/** Collect all rendered text nodes under the given DOM root. */
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

/**
 * Build a minimal controllable clock so we can force the animation tick
 * deterministically without the real Ink clock driving us.
 */
function createControllableClock(): { clock: Clock; tick: () => void } {
  const real = createClock(1_000_000);
  const callbacks = new Set<() => void>();
  const originalSubscribe = real.subscribe;
  const clock: Clock = {
    ...real,
    subscribe(cb, keepAlive) {
      callbacks.add(cb);
      const unsub = originalSubscribe.call(real, cb, keepAlive);
      return () => {
        callbacks.delete(cb);
        unsub();
      };
    },
  };
  return {
    clock,
    tick: () => {
      for (const cb of Array.from(callbacks)) cb();
    },
  };
}

describe("Banner", () => {
  test("renders with default mode", async () => {
    const { stdout, unmount } = await mount(<Banner mode="default" />);
    const text = collectText(getRoot(stdout));
    expect(text).toContain("MODE");
    expect(text).toContain("default");
    expect(text).toContain("MODEL");
    expect(text).toContain("loading");
    expect(text).toContain("READY");
    unmount();
  });

  test("does not fake a provider/model default when model is absent", async () => {
    const { stdout, unmount } = await mount(<Banner mode="default" />);
    const text = collectText(getRoot(stdout));
    expect(text).not.toContain("grok");
    expect(text).toContain("loading");
    unmount();
  });

  test("shows mode indicator in the mode's themed colour", async () => {
    const { stdout, unmount } = await mount(<Banner mode="plan" />);
    const root = getRoot(stdout);
    // Walk the tree collecting (textStyles.color, text) pairs and check
    // at least one mode-value string containing "plan" is painted with
    // the plan-mode colour.
    const matches: string[] = [];
    const walk = (n: DOMElement): void => {
      for (const child of n.childNodes) {
        if (child.nodeName === "#text") continue;
        const el = child as DOMElement;
        if (el.nodeName === "ink-text") {
          const style = (el as unknown as { textStyles?: { color?: string } })
            .textStyles;
          const inner = collectText(el);
          if (style?.color === theme.colors.modePlan && inner.includes("plan")) {
            matches.push(inner);
          }
        }
        walk(el);
      }
    };
    walk(root);
    expect(matches.some((match) => match.includes("plan"))).toBe(true);
    unmount();
  });

  test("shows active tool count when greater than zero", async () => {
    const { stdout, unmount } = await mount(
      <Banner mode="default" activeToolCount={3} />,
    );
    const text = collectText(getRoot(stdout));
    expect(text).toContain("tools");
    expect(text).toContain("3");
    unmount();
  });

  test("renders [PLAN] marker when hasPlanActive is true", async () => {
    const { stdout, unmount } = await mount(
      <Banner mode="plan" hasPlanActive />,
    );
    const text = collectText(getRoot(stdout));
    expect(text).toContain("PLAN");
    expect(text).toContain("ready");
    unmount();
  });

  test("no plan marker when plan is inactive", async () => {
    const { stdout, unmount } = await mount(<Banner mode="default" />);
    const text = collectText(getRoot(stdout));
    expect(text).not.toContain("PLAN");
    unmount();
  });

  test("streaming spinner advances on tick", async () => {
    const { clock, tick } = createControllableClock();
    const observed = new Set<string>();
    function Probe(): React.ReactElement {
      return (
        <ClockContext.Provider value={clock}>
          <Banner mode="default" isStreaming />
        </ClockContext.Provider>
      );
    }
    const { stdout, unmount } = await mount(<Probe />);
    // Snapshot the first spinner character.
    const snapshotSpinner = (): string => {
      const root = getRoot(stdout);
      // The spinner is the very first ink-text whose parent has no [
      // prefix, colour primary. Easiest to grep the full text for one
      // of the known spinner glyphs instead.
      const text = collectText(root);
      for (const glyph of ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]) {
        if (text.includes(glyph)) {
          observed.add(glyph);
          return glyph;
        }
      }
      return "";
    };
    snapshotSpinner();
    for (let i = 0; i < 4; i += 1) {
      tick();
      await new Promise((r) => setTimeout(r, 15));
      snapshotSpinner();
    }
    // The spinner should have rotated to at least two distinct glyphs.
    expect(observed.size).toBeGreaterThanOrEqual(2);
    unmount();
  });
});
