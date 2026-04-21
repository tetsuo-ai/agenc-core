/**
 * Wave 4-A ExecCell tests.
 *
 * The `collapseOutput` helper is pure and unit-tested directly. The
 * component's status badge is exercised by mounting the cell with
 * different exit-state combinations and asserting on the stdout frame
 * captured from the PassThrough.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import { ExecCell, collapseOutput } from "./ExecCell.js";

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
): Promise<{ unmount: () => void; stdout: PassThrough }> {
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

describe("collapseOutput", () => {
  test("preserves short outputs unchanged", () => {
    const input = "line 1\nline 2\nline 3";
    expect(collapseOutput(input)).toBe(input);
  });

  test("collapses a 30-line output to head + elision marker + tail", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const input = lines.join("\n");
    const out = collapseOutput(input);
    const outLines = out.split("\n");
    // 10 head + 1 marker + 5 tail = 16 lines total.
    expect(outLines.length).toBe(16);
    expect(outLines[0]).toBe("line 1");
    expect(outLines[9]).toBe("line 10");
    expect(outLines[10]).toMatch(/^\.\.\. \(15 lines elided\) \.\.\.$/);
    expect(outLines[11]).toBe("line 26");
    expect(outLines[15]).toBe("line 30");
  });
});

describe("ExecCell status badge", () => {
  test("running state shows the ·  glyph", async () => {
    const { unmount, stdout } = await mount(
      <ExecCell command="npm run build" stdout="" stderr="" />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("\u00B7");
    unmount();
  });

  test("exit 0 shows ✓ 0", async () => {
    const { unmount, stdout } = await mount(
      <ExecCell
        command="echo hi"
        stdout="hi\n"
        stderr=""
        exitCode={0}
        durationMs={120}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("\u2713");
    expect(frame).toContain("0");
    unmount();
  });

  test("exit 1 shows ✗ 1", async () => {
    const { unmount, stdout } = await mount(
      <ExecCell
        command="false"
        stdout=""
        stderr="boom"
        exitCode={1}
        durationMs={40}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("\u2717");
    expect(frame).toContain("1");
    unmount();
  });

  test("timed out shows ⚠ timeout", async () => {
    const { unmount, stdout } = await mount(
      <ExecCell
        command="sleep 99"
        stdout=""
        stderr=""
        timedOut
        durationMs={30000}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("\u26A0");
    expect(frame).toContain("timeout");
    unmount();
  });
});
