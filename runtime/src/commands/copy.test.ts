import { describe, expect, it } from "vitest";

import copyCommand, {
  collectCopyableMessages,
  formatCopyExport,
} from "./copy.js";
import type { Session } from "../session/session.js";

function stubSession(history: unknown[]): Session {
  return {
    state: { unsafePeek: () => ({ history }) },
  } as unknown as Session;
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
    const result = await copyCommand.execute({
      session: stubSession([
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "second" },
      ]),
      argsRaw: "",
      cwd: "/tmp/ws",
      home: "/home/test",
    });
    expect(result).toEqual({ kind: "text", text: "answer" });
  });

  it("exports the full transcript when requested", async () => {
    const result = await copyCommand.execute({
      session: stubSession([
        { role: "user", content: "question" },
        { role: "assistant", content: "answer" },
      ]),
      argsRaw: "all",
      cwd: "/tmp/ws",
      home: "/home/test",
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toBe("USER:\nquestion\n\nASSISTANT:\nanswer");
    }
  });

  it("reports usage for unknown targets", async () => {
    const result = await copyCommand.execute({
      session: stubSession([]),
      argsRaw: "clipboard",
      cwd: "/tmp/ws",
      home: "/home/test",
    });
    expect(result.kind).toBe("error");
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
