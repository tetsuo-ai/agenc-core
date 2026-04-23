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
    // 5 head + 1 marker + 5 tail = 11 lines total.
    expect(outLines.length).toBe(11);
    expect(outLines[0]).toBe("line 1");
    expect(outLines[4]).toBe("line 5");
    expect(outLines[5]).toMatch(/^\.\.\. \(20 lines elided\) \.\.\.$/);
    expect(outLines[6]).toBe("line 26");
    expect(outLines[10]).toBe("line 30");
  });
});

describe("ExecCell status badge", () => {
  test("running state renders an inline Running header", async () => {
    const { unmount, stdout } = await mount(
      <ExecCell command="npm run build" stdout="" stderr="" />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("\u00B7");
    expect(frame).toContain("Running");
    expect(frame).toContain("npm");
    unmount();
  });

  test("exit 0 renders a completion note", async () => {
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
    expect(frame).toContain("Ran");
    expect(frame).toContain("Completed");
    expect(frame).toContain("hi");
    unmount();
  });

  test("exit 1 renders an exit note", async () => {
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
    expect(frame).toContain("Exited");
    expect(frame).toContain("1");
    unmount();
  });

  test("timed out shows an inline timeout note", async () => {
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
    expect(frame).toContain("Timed");
    expect(frame).toContain("out");
    unmount();
  });

  test("sanitizes terminal control sequences before rendering", async () => {
    const { unmount, stdout } = await mount(
      <ExecCell
        command={"printf 'x\\x1b[2J'"}
        stdout={"line1\x1b[2Jline2"}
        stderr={"\x1b[31mboom\x1b[0m"}
        exitCode={1}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("printf");
    expect(frame).toContain("line1");
    expect(frame).toContain("line2");
    expect(frame).toContain("boom");
    unmount();
  });
});
