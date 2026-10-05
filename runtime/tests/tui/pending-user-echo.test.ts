import { describe, expect, it } from "vitest";

import {
  countUserTextRows,
  withPendingUserEcho,
  type PendingUserEcho,
} from "../../src/tui/pending-user-echo.js";
import { makeUserMessage } from "../../src/tui/session-transcript.js";

const assistant = { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
const toolResult = { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } };
const done = { type: "system", subtype: "turn_duration", durationMs: 1000 };

function echo(userRowsBefore: number, lastUserTextBefore: string | null = "earlier"): PendingUserEcho {
  return {
    id: "client-1",
    message: makeUserMessage("build the cli", "pending-echo:client-1"),
    text: "build the cli",
    userRowsBefore,
    lastUserTextBefore,
  };
}

describe("pending user echo", () => {
  it("shows the sent prompt while the daemon has not echoed it", () => {
    const messages = [makeUserMessage("earlier"), assistant];
    const shown = withPendingUserEcho(messages, echo(1), true);

    expect(shown).toHaveLength(3);
    expect(shown[2]).toMatchObject({ type: "user", message: { content: "build the cli" } });
  });

  it("hands over to the daemon's own user row once it lands", () => {
    const echoed = [makeUserMessage("earlier"), assistant, makeUserMessage("build the cli")];

    expect(withPendingUserEcho(echoed, echo(1), true)).toBe(echoed);
  });

  it("hands over even when the transcript re-projects and rows move", () => {
    // The row count before the send included a closing line that the next
    // projection folded away; the new user row lands at an earlier index.
    const reprojected = [makeUserMessage("earlier"), makeUserMessage("build the cli"), assistant];

    expect(withPendingUserEcho(reprojected, echo(1), true)).toBe(reprojected);
  });

  it("does not count tool results or closing lines as the user's row", () => {
    const messages = [makeUserMessage("earlier"), assistant, toolResult, done];

    expect(countUserTextRows(messages)).toBe(1);
    expect(withPendingUserEcho(messages, echo(1), true)).toHaveLength(5);
  });

  it("hands over when older rows left the transcript before the daemon row landed", () => {
    // Two prompts were on screen when this one was sent; the transcript then
    // dropped the oldest, so the count stays at two with the new row in.
    const shrunk = [makeUserMessage("earlier"), assistant, makeUserMessage("build the cli")];

    expect(withPendingUserEcho(shrunk, echo(2), true)).toBe(shrunk);
  });

  it("keeps the echo for a repeat of the previous prompt until the count moves", () => {
    const before = [makeUserMessage("build the cli"), assistant];

    expect(withPendingUserEcho(before, echo(1, "build the cli"), true)).toHaveLength(3);
    const landed = [...before, makeUserMessage("build the cli")];
    expect(withPendingUserEcho(landed, echo(1, "build the cli"), true)).toBe(landed);
  });

  it("drops the echo when the submission settles or fails", () => {
    const messages = [assistant];

    expect(withPendingUserEcho(messages, echo(0), false)).toBe(messages);
    expect(withPendingUserEcho(messages, null, true)).toBe(messages);
  });
});
