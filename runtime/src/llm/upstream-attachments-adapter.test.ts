import { describe, it, expect } from "vitest";

import type { PastedContent } from "../agenc/upstream/utils/config.js";
import { pastedContentsToLLMMessage } from "../agenc/adapters/upstream-attachments.js";

describe("pastedContentsToLLMMessage (TUI attachments → multipart user message)", () => {
  it("returns null for an empty record", () => {
    expect(pastedContentsToLLMMessage({})).toBeNull();
  });

  it("converts a single text entry into a text content part", () => {
    const record: Record<number, PastedContent> = {
      1: { id: 1, type: "text", content: "hello" },
    };
    const got = pastedContentsToLLMMessage(record);
    expect(got).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("converts an image entry into an image_url with a base64 data URL using the supplied mediaType", () => {
    const record: Record<number, PastedContent> = {
      1: {
        id: 1,
        type: "image",
        content: "BASE64DATA",
        mediaType: "image/jpeg",
      },
    };
    const got = pastedContentsToLLMMessage(record);
    expect(got).toEqual({
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,BASE64DATA" },
        },
      ],
    });
  });

  it("defaults image mediaType to image/png when not provided", () => {
    const record: Record<number, PastedContent> = {
      1: { id: 1, type: "image", content: "PNG" },
    };
    const got = pastedContentsToLLMMessage(record);
    const part = got?.content[0] as { type: "image_url"; image_url: { url: string } };
    expect(part.image_url.url).toBe("data:image/png;base64,PNG");
  });

  it("orders parts by id (paste order) regardless of object key iteration", () => {
    const record: Record<number, PastedContent> = {
      3: { id: 3, type: "text", content: "third" },
      1: { id: 1, type: "text", content: "first" },
      2: { id: 2, type: "image", content: "X", mediaType: "image/png" },
    };
    const got = pastedContentsToLLMMessage(record);
    expect(got?.content.length).toBe(3);
    expect((got?.content[0] as { type: "text"; text: string }).text).toBe(
      "first",
    );
    expect(
      (got?.content[1] as { type: "image_url"; image_url: { url: string } })
        .image_url.url,
    ).toBe("data:image/png;base64,X");
    expect((got?.content[2] as { type: "text"; text: string }).text).toBe(
      "third",
    );
  });

  it("uses role 'user' on the produced message", () => {
    const record: Record<number, PastedContent> = {
      1: { id: 1, type: "text", content: "x" },
    };
    expect(pastedContentsToLLMMessage(record)?.role).toBe("user");
  });

  it("silently skips entries whose type is neither 'text' nor 'image'", () => {
    const record: Record<number, PastedContent> = {
      1: { id: 1, type: "text", content: "kept" },
      2: {
        id: 2,
        type: "file" as PastedContent["type"],
        content: "should-be-skipped",
      },
      3: { id: 3, type: "text", content: "also kept" },
    };
    const got = pastedContentsToLLMMessage(record);
    expect(got?.content.length).toBe(2);
    const texts = (got?.content ?? []).map(
      (p) => (p as { type: "text"; text: string }).text,
    );
    expect(texts).toEqual(["kept", "also kept"]);
  });

  it("returns null when every entry has an unrecognized type", () => {
    const record: Record<number, PastedContent> = {
      1: {
        id: 1,
        type: "file" as PastedContent["type"],
        content: "x",
      },
      2: {
        id: 2,
        type: "video" as PastedContent["type"],
        content: "y",
      },
    };
    expect(pastedContentsToLLMMessage(record)).toBeNull();
  });
});
