import { describe, expect, test } from "vitest";

import { eventsToMessages } from "./events-to-messages.js";

describe("eventsToMessages OpenClaude structured user content parity", () => {
  test("preserves text and image user content blocks as renderable shapes", () => {
    const rows = eventsToMessages([
      {
        id: "u1",
        type: "user_message",
        payload: {
          message: [
            { type: "text", text: "look at this" },
            { type: "image_url", image_url: { url: "file:///tmp/cat.png" } },
          ],
          images: ["/tmp/cat.png"],
        },
      },
    ]);

    expect(rows[0]?.kind).toBe("user");
    expect(rows[0]?.content).toContain("look at this");
    expect(rows[0]?.userContent?.[0]).toEqual({
      type: "text",
      text: "look at this",
    });
    expect(rows[0]?.userContent?.[1]).toMatchObject({
      type: "image",
      imagePath: "/tmp/cat.png",
      url: "file:///tmp/cat.png",
    });
  });

  test("keeps tool results and attachments distinct from plain prompt text", () => {
    const rows = eventsToMessages([
      {
        id: "u2",
        type: "user_message",
        payload: {
          message: [
            { type: "tool_result", tool_use_id: "call_1", content: "ok" },
            { type: "attachment", label: "doc", path: "docs/a.md" },
          ],
        },
      },
    ]);

    expect(rows[0]?.userContent?.[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "call_1",
      content: "ok",
    });
    expect(rows[0]?.userContent?.[1]).toMatchObject({
      type: "attachment",
      label: "doc",
      path: "docs/a.md",
    });
  });
});
