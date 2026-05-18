import { describe, expect, it, vi } from "vitest";

import {
  collectCopyableMessages,
  copyTextToClipboard,
  formatCopyExport,
  runCopy,
  type CopyClipboardDeps,
} from "./copy.js";
import type { Session } from "../session/session.js";
import type { ClipboardPath } from "../tui/ink/termio/osc.js";

function stubSession(history: unknown[]): Session {
  return {
    state: { unsafePeek: () => ({ history }) },
  } as unknown as Session;
}

function clipboardDeps(
  path: ClipboardPath = "native",
  sequence = "\x1b]52;c;YW5zd2Vy\x07",
): CopyClipboardDeps {
  return {
    getClipboardPath: vi.fn(() => path),
    setClipboard: vi.fn(async () => sequence),
    writeSequence: vi.fn(),
  };
}

describe("copyCommand", () => {
  it("extracts text and multimodal text parts from transcript history", () => {
    const messages = collectCopyableMessages([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "image_url", image_url: { url: "data:" } },
        ],
      },
      { role: "system", content: "runtime-only" },
    ]);
    expect(messages).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello\n[image]" },
    ]);
  });

  it("defaults to the latest assistant message", async () => {
    const deps = clipboardDeps("osc52");
    const result = await runCopy({
      session: stubSession([
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "second" },
      ]),
      argsRaw: "",
      cwd: "/tmp/ws",
      home: "/home/test",
    }, deps);

    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toBe(
        "Sent to clipboard via OSC 52 (6 characters, 1 line); paste support depends on terminal settings.",
      );
    }
    expect(deps.setClipboard).toHaveBeenCalledWith("answer");
    expect(deps.writeSequence).toHaveBeenCalledWith("\x1b]52;c;YW5zd2Vy\x07");
  });

  it("exports the full transcript when requested", async () => {
    const deps = clipboardDeps();
    const result = await runCopy({
      session: stubSession([
        { role: "user", content: "question" },
        { role: "assistant", content: "answer" },
      ]),
      argsRaw: "all",
      cwd: "/tmp/ws",
      home: "/home/test",
    }, deps);

    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toBe("Copied to clipboard (33 characters, 5 lines).");
    }
    expect(deps.setClipboard).toHaveBeenCalledWith(
      "USER:\nquestion\n\nASSISTANT:\nanswer",
    );
  });

  it("reports usage for unknown targets", async () => {
    const deps = clipboardDeps();
    const result = await runCopy({
      session: stubSession([]),
      argsRaw: "clipboard",
      cwd: "/tmp/ws",
      home: "/home/test",
    }, deps);

    expect(result.kind).toBe("error");
    expect(deps.setClipboard).not.toHaveBeenCalled();
    expect(deps.writeSequence).not.toHaveBeenCalled();
  });

  it("does not write an empty clipboard control sequence", async () => {
    const deps = clipboardDeps("native", "");
    await expect(copyTextToClipboard("answer", deps)).resolves.toBe(
      "Copied to clipboard (6 characters, 1 line).",
    );
    expect(deps.setClipboard).toHaveBeenCalledWith("answer");
    expect(deps.writeSequence).not.toHaveBeenCalled();
  });

  it("formats multiple messages with role labels", () => {
    expect(
      formatCopyExport([
        { role: "user", text: "u" },
        { role: "assistant", text: "a" },
      ]),
    ).toBe("USER:\nu\n\nASSISTANT:\na");
  });
});
