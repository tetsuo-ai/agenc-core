import { describe, expect, it } from "vitest";

import type { DisplayAttachment } from "../../src/mcp-client/display-attachments.js";
import { boundDisplayCompletionEvent } from "../../src/session/display-completion.js";
import type { Event } from "../../src/session/event-log.js";

const OMITTED = "\n[Additional display attachments omitted: journal size limit]";

function attachment(
  id: string,
  data: string = id,
): DisplayAttachment {
  return {
    id,
    kind: "table",
    title: id,
    mimeType: "application/json",
    size: data.length,
    digest: id,
    data,
  };
}

function completion(options: {
  readonly result?: string;
  readonly attachments?: readonly DisplayAttachment[];
  readonly extraMetadata?: Record<string, unknown>;
}): Event & { readonly msg: { readonly type: "tool_call_completed" } } {
  return {
    id: "display-complete",
    msg: {
      type: "tool_call_completed",
      payload: {
        callId: "call_1",
        toolName: "mcp.fixture.show",
        result: options.result ?? "ok",
        isError: false,
        metadata: {
          ...(options.extraMetadata ?? {}),
          ...(options.attachments === undefined
            ? {}
            : { displayAttachments: options.attachments }),
        },
      },
    },
  };
}

describe("boundDisplayCompletionEvent", () => {
  it("returns the same event when there is nothing to persist", () => {
    const missing = completion({});
    const empty = completion({ attachments: [] });
    expect(boundDisplayCompletionEvent(missing)).toBe(missing);
    expect(boundDisplayCompletionEvent(empty)).toBe(empty);
  });

  it("keeps a small attachment and the original result", () => {
    const chart = attachment("chart", '{"title":"NVDA"}');
    const event = completion({ result: "shown", attachments: [chart] });
    const bounded = boundDisplayCompletionEvent(event);
    expect(bounded).not.toBe(event);
    expect(bounded.msg.payload.result).toBe("shown");
    expect(bounded.msg.payload.metadata?.displayAttachments).toEqual([chart]);
    expect(event.msg.payload.metadata?.displayAttachments).toEqual([chart]);
  });

  it("drops an oversized attachment but still keeps a later one that fits", () => {
    const first = attachment("first", "a".repeat(2_200_000));
    const oversized = attachment("oversized", "b".repeat(2_200_000));
    const later = attachment("later", "fits");
    const bounded = boundDisplayCompletionEvent(completion({
      result: "caption",
      attachments: [first, oversized, later],
    }));

    expect(bounded.msg.payload.metadata?.displayAttachments).toEqual([first, later]);
    expect(bounded.msg.payload.result.endsWith(OMITTED)).toBe(true);
    expect(bounded.msg.payload.result.startsWith("caption")).toBe(true);
  });

  it("shortens a huge tool result so the journal row stays under the limit", () => {
    const bounded = boundDisplayCompletionEvent(completion({
      result: "y".repeat(4_200_000),
      attachments: [attachment("tiny", "ok")],
    }));
    expect(bounded.msg.payload.metadata?.displayAttachments).toEqual([
      attachment("tiny", "ok"),
    ]);
    expect(bounded.msg.payload.result.length).toBeLessThan(4_200_000);
    expect(bounded.msg.payload.result.length).toBeGreaterThan(0);
    expect(bounded.msg.payload.result.includes(OMITTED)).toBe(false);
  });

  it("refuses metadata that already exceeds the journal limit before any attachment is added", () => {
    expect(() => boundDisplayCompletionEvent(completion({
      attachments: [attachment("tiny", "ok")],
      extraMetadata: { note: "z".repeat(4_200_000) },
    }))).toThrow(/display completion metadata exceeds journal size limit/);
  });
});
