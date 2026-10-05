import { describe, expect, it } from "vitest";

import {
  hasUserRowAfter,
  withPendingUserEcho,
  type PendingUserEcho,
} from "../../src/tui/pending-user-echo.js";
import { makeUserMessage } from "../../src/tui/session-transcript.js";

const assistant = { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
const toolResult = { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } };

function echoAfter(index: number): PendingUserEcho {
  return { id: "client-1", message: makeUserMessage("build the cli", "pending-echo:client-1"), afterIndex: index };
}

describe("pending user echo", () => {
  it("shows the sent prompt while the daemon has not echoed it", () => {
    const messages = [assistant];
    const shown = withPendingUserEcho(messages, echoAfter(1), true);

    expect(shown).toHaveLength(2);
    expect(shown[1]).toMatchObject({ type: "user", message: { content: "build the cli" } });
  });

  it("hands over to the daemon's own user row once it lands", () => {
    const echoed = [assistant, makeUserMessage("build the cli")];

    expect(withPendingUserEcho(echoed, echoAfter(1), true)).toBe(echoed);
  });

  it("ignores user rows from before the send and tool results after it", () => {
    const messages = [makeUserMessage("earlier prompt"), assistant, toolResult];

    expect(hasUserRowAfter(messages, 1)).toBe(false);
    expect(withPendingUserEcho(messages, echoAfter(1), true)).toHaveLength(4);
  });

  it("drops the echo when the submission settles or fails", () => {
    const messages = [assistant];

    expect(withPendingUserEcho(messages, echoAfter(1), false)).toBe(messages);
    expect(withPendingUserEcho(messages, null, true)).toBe(messages);
  });

  it("survives a transcript that shrank below the send point", () => {
    expect(withPendingUserEcho([], echoAfter(3), true)).toHaveLength(1);
  });
});
