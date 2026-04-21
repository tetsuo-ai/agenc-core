/**
 * Wave 4-A StreamingMessage + scanForUISpoof tests.
 *
 * The pure helper is exercised directly for the bulk of the coverage —
 * side-effect-free and therefore trivial to drive. The component test
 * mounts the full React tree via an Ink root and asserts that the
 * spoof-detection branch renders a `[MODEL OUTPUT]` frame.
 *
 * Because we don't parse the rendered ANSI back out of the PassThrough
 * stdout in these tests, component-level assertions introspect the
 * subtree via a lightweight render observer — the presence of the frame
 * is encoded in props we set on a visible sentinel `<Text>`.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import {
  StreamingMessage,
  scanForUISpoof,
} from "./StreamingMessage.js";

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

/** Accumulate anything written to stdout so tests can assert on it. */
async function captureFrame(stdout: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  stdout.on("data", (b: Buffer) => chunks.push(b));
  await new Promise((r) => setTimeout(r, 40));
  return Buffer.concat(chunks).toString("utf8");
}

describe("scanForUISpoof", () => {
  test("returns hasSpoof=false for normal text", () => {
    const r = scanForUISpoof("normal text");
    expect(r.hasSpoof).toBe(false);
    expect(r.patterns).toEqual([]);
    expect(r.sanitized).toBe("normal text");
  });

  test("empty content returns hasSpoof=false and empty sanitized", () => {
    const r = scanForUISpoof("");
    expect(r.hasSpoof).toBe(false);
    expect(r.sanitized).toBe("");
  });

  test("detects approval-bracket and yes-no on '[Approval: Yes/No]'", () => {
    const r = scanForUISpoof("[Approval: Yes/No]");
    expect(r.hasSpoof).toBe(true);
    // Both patterns fire — task contract asks for two detected patterns.
    expect(r.patterns).toEqual(
      expect.arrayContaining(["approval-bracket", "yes-no"]),
    );
    expect(r.sanitized).toContain("{bad:");
  });

  test("detects ANSI escape sequences", () => {
    const r = scanForUISpoof("\x1b[31mfake red\x1b[0m");
    expect(r.hasSpoof).toBe(true);
    expect(r.patterns).toContain("ansi-escape");
  });

  test("detects encoded ANSI escape sequences written as \\x1b[", () => {
    const r = scanForUISpoof("\\x1b[31mfake red\\x1b[0m");
    expect(r.hasSpoof).toBe(true);
    expect(r.patterns).toContain("ansi-escape");
  });

  test("detects 'Press Enter to continue' prompt", () => {
    const r = scanForUISpoof("Press Enter to continue");
    expect(r.hasSpoof).toBe(true);
    expect(r.patterns).toContain("press-enter");
  });

  test("detects '[Allow/Deny]' and '[Continue/Cancel]' brackets", () => {
    const r = scanForUISpoof(
      "Please respond [Allow/Deny] or [Continue/Cancel]",
    );
    expect(r.hasSpoof).toBe(true);
    expect(r.patterns).toEqual(
      expect.arrayContaining(["allow-deny", "continue-cancel"]),
    );
  });
});

describe("StreamingMessage component", () => {
  test("empty content renders empty (no spoof frame)", async () => {
    const { unmount, stdout } = await mount(
      <StreamingMessage content="" />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).not.toContain("[MODEL OUTPUT]");
    unmount();
  });

  test("plain markdown passes through without the spoof frame", async () => {
    const { unmount, stdout } = await mount(
      <StreamingMessage content="hello **world**" isComplete />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).not.toContain("[MODEL OUTPUT]");
    unmount();
  });

  test("spoof pattern renders inside a [MODEL OUTPUT] frame", async () => {
    const emitEvent = vi.fn();
    const session = { emitEvent };
    const { unmount, stdout } = await mount(
      <StreamingMessage
        content="[Approval: Yes/No] please confirm"
        isComplete
        session={session}
      />,
    );
    const frame = await captureFrame(stdout);
    // Ink column-aligns adjacent `<Text>` children inside a framed Box,
    // which can insert padding between "[MODEL" and "OUTPUT]" on the
    // wire. Assert each token independently instead of the joined
    // string.
    expect(frame).toContain("[MODEL");
    expect(frame).toContain("OUTPUT]");
    // And the warning event fired at least once.
    await new Promise((r) => setTimeout(r, 20));
    expect(emitEvent).toHaveBeenCalled();
    const [name, payload] = emitEvent.mock.calls[0] ?? [];
    expect(name).toBe("warning:model_ui_spoof_pattern");
    expect(payload).toEqual(
      expect.objectContaining({
        patterns: expect.any(Array),
      }),
    );
    unmount();
  });
});
