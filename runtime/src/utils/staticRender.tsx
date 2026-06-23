import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useLayoutEffect } from 'react';
import { PassThrough } from 'stream';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import { render, useApp } from '../tui/ink.js';

// This is a workaround for the fact that Ink doesn't support multiple <Static>
// components in the same render tree. Instead of using a <Static> we just render
// the component to a string and then print it to stdout

/**
 * Wrapper component that exits after rendering.
 * Uses useLayoutEffect to ensure we wait for React's commit phase to complete
 * before exiting. This is more robust than process.nextTick() for React 19's
 * async render cycle.
 */
function RenderOnceAndExit(t0: { children: React.ReactNode }) {
  const $ = _c(5);
  const {
    children
  } = t0;
  const {
    exit
  } = useApp();
  let t1;
  let t2;
  if ($[0] !== exit) {
    t1 = () => {
      const timer = setTimeout(exit, 0);
      return () => clearTimeout(timer);
    };
    t2 = [exit];
    $[0] = exit;
    $[1] = t1;
    $[2] = t2;
  } else {
    t1 = $[1];
    t2 = $[2];
  }
  useLayoutEffect(t1, t2);
  let t3;
  if ($[3] !== children) {
    t3 = <>{children}</>;
    $[3] = children;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  return t3;
}

// DEC synchronized update markers used by terminals
const SYNC_START = '\x1B[?2026h';
const SYNC_END = '\x1B[?2026l';

/**
 * Extracts content from the last non-empty complete frame in Ink's output.
 * Ink with non-TTY stdout outputs multiple frames, each wrapped in DEC synchronized
 * update sequences ([?2026h ... [?2026l). React/Ink can commit popup-heavy
 * trees over several frames, so the stable final frame is the useful snapshot.
 */
function extractFirstFrame(output: string): string {
  let frame: string | null = null;
  let cursor = 0;
  while (cursor < output.length) {
    const startIndex = output.indexOf(SYNC_START, cursor);
    if (startIndex === -1) break;
    const contentStart = startIndex + SYNC_START.length;
    const endIndex = output.indexOf(SYNC_END, contentStart);
    if (endIndex === -1) break;
    const nextFrame = output.slice(contentStart, endIndex);
    if (nextFrame.trim().length > 0) frame = nextFrame;
    cursor = endIndex + SYNC_END.length;
  }
  return frame ?? output;
}

/**
 * Renders a React node to a string with ANSI escape codes (for terminal output).
 */
export type StaticRenderViewport =
  | number
  | {
      readonly columns?: number;
      readonly rows?: number;
      readonly color?: boolean;
    };

function normalizeViewport(
  viewport?: StaticRenderViewport,
): { readonly columns?: number; readonly rows?: number; readonly color?: boolean } {
  if (typeof viewport === 'number') {
    return { columns: viewport };
  }
  return viewport ?? {};
}

export async function renderToAnsiString(node: React.ReactNode, viewport?: StaticRenderViewport): Promise<string> {
  let output = '';
  const previousChalkLevel = chalk.level;

  try {
    // Capture all writes. Set .columns so Ink (ink.tsx:~165) picks up a
    // chosen width instead of PassThrough's undefined → 80 fallback —
    // useful for rendering at terminal width for file dumps that should
    // match what the user sees on screen.
    const stream = new PassThrough();
    const { columns, rows, color } = normalizeViewport(viewport);
    if (color === true && chalk.level < 3) {
      chalk.level = 3;
    }
    if (columns !== undefined) {
      (stream as unknown as {
        columns: number;
      }).columns = columns;
    }
    if (rows !== undefined) {
      (stream as unknown as {
        rows: number;
      }).rows = rows;
    }
    stream.on('data', chunk => {
      output += chunk.toString();
    });

    // Render the component wrapped in RenderOnceAndExit
    // Non-TTY stdout (PassThrough) gives full-frame output instead of diffs
    const instance = await render(<RenderOnceAndExit>{node}</RenderOnceAndExit>, {
      stdout: stream as unknown as NodeJS.WriteStream,
      patchConsole: false
    });

    // Wait for the component to exit naturally, with a timeout guard so
    // tests never hang indefinitely if a render error prevents exit().
    await Promise.race([
      instance.waitUntilExit(),
      new Promise<void>(resolve => setTimeout(resolve, 3000)),
    ]);

    // Extract only the first frame's content to avoid duplication
    // (Ink outputs multiple frames in non-TTY mode)
    return extractFirstFrame(output);
  } finally {
    // Always restore chalk's level — even when render()/waitUntilExit()
    // reject. The rejection propagates to the caller (whose await throws);
    // it must never leave the returned promise unsettled (see the prior
    // `new Promise(async resolve => …)` executor, which had no catch and so
    // hung forever on an infrastructure-level render rejection).
    chalk.level = previousChalkLevel;
  }
}

/**
 * Renders a React node to a plain text string (ANSI codes stripped).
 */
export async function renderToString(node: React.ReactNode, viewport?: StaticRenderViewport): Promise<string> {
  const output = await renderToAnsiString(node, viewport);
  return stripAnsi(output);
}
