import { describe, expect, it } from "vitest";

import { userPromptFromMessages } from "../scripts/local-openai-compatible-mock.mjs";

describe("local OpenAI-compatible mock fixture", () => {
  it("uses the newest user frame after auto-compaction", () => {
    const compactedTranscript = [
      '<message role="user">',
      "Reply with the single word FIRST",
      "</message>",
      '<message role="assistant">',
      "Earlier response",
      "</message>",
      '<message role="user">',
      "Use the Bash tool to run exactly: printf 'fixture\\n'",
      "</message>",
    ].join("\n");

    expect(
      userPromptFromMessages([
        { role: "user", content: compactedTranscript },
      ]),
    ).toBe("Use the Bash tool to run exactly: printf 'fixture\\n'");
  });

  it("uses the live request appended after a continuation summary", () => {
    const continuation = [
      "This session is being continued from a previous conversation.",
      '<message role="user">',
      "Reply with the single word FIRST",
      "</message>",
      '<message role="assistant">',
      "Earlier response",
      "</message>",
      "Use the Read tool to read README.md, then reply DONE",
    ].join("\n");

    expect(
      userPromptFromMessages([{ role: "user", content: continuation }]),
    ).toBe("Use the Read tool to read README.md, then reply DONE");
  });

  it("ignores the closing transcript wrapper in a compaction request", () => {
    const compactionRequest = [
      "Summarize the transcript.",
      "<transcript>",
      '<message role="user">',
      "Use the Bash tool to run exactly: printf 'fixture\\n'",
      "</message>",
      "</transcript>",
    ].join("\n");

    expect(
      userPromptFromMessages([
        { role: "user", content: compactionRequest },
      ]),
    ).toBe("Use the Bash tool to run exactly: printf 'fixture\\n'");
  });

});
