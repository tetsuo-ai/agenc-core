import { describe, expect, it, vi } from "vitest";
import { createPromptBridge } from "./prompts.js";

function makeClient(overrides: {
  listPrompts?: ReturnType<typeof vi.fn>;
  getPrompt?: ReturnType<typeof vi.fn>;
}) {
  return {
    listPrompts: overrides.listPrompts ?? vi.fn(),
    getPrompt: overrides.getPrompt ?? vi.fn(),
  };
}

describe("createPromptBridge", () => {
  it("lists + namespaces prompts", async () => {
    const client = makeClient({
      listPrompts: vi.fn().mockResolvedValue({
        prompts: [
          {
            name: "review_code",
            description: "review diff",
            arguments: [{ name: "path", required: true }],
          },
        ],
      }),
    });
    const bridge = await createPromptBridge(client, "srv");
    const items = await bridge.listPrompts();
    expect(items).toHaveLength(1);
    expect(items[0].namespacedName).toBe("mcp.srv.review_code");
    expect(items[0].arguments?.[0]).toEqual({ name: "path", required: true });
  });

  it("normalizes malformed prompt catalog entries", async () => {
    const client = makeClient({
      listPrompts: vi.fn().mockResolvedValue({
        prompts: [
          null,
          "noise",
          { name: 42, description: "bad name" },
          { description: "missing name" },
          { name: "   ", description: "blank name" },
          {
            name: "safe",
            description: 123,
            arguments: [
              null,
              { name: 42, required: true },
              { name: "topic", description: 99, required: "yes" },
              { name: "path", description: "target path", required: true },
            ],
          },
        ],
      }),
    });

    const bridge = await createPromptBridge(client, "srv");
    const items = await bridge.listPrompts();

    expect(items).toEqual([
      {
        serverName: "srv",
        name: "safe",
        namespacedName: "mcp.srv.safe",
        arguments: [
          { name: "topic" },
          { name: "path", description: "target path", required: true },
        ],
      },
    ]);
  });

  it("treats non-array prompt catalogs as empty", async () => {
    const client = makeClient({
      listPrompts: vi.fn().mockResolvedValue({
        prompts: { name: "not-array" },
      }),
    });

    const bridge = await createPromptBridge(client, "srv");

    await expect(bridge.listPrompts()).resolves.toEqual([]);
  });

  it("returns empty list on upstream error", async () => {
    const client = makeClient({
      listPrompts: vi.fn().mockRejectedValue(new Error("not supported")),
    });
    const bridge = await createPromptBridge(client, "srv");
    await expect(bridge.listPrompts()).resolves.toEqual([]);
  });

  it("renders a prompt into plain-text messages", async () => {
    const client = makeClient({
      getPrompt: vi.fn().mockResolvedValue({
        description: "desc",
        messages: [
          { role: "user", content: { type: "text", text: "hello" } },
          { role: "assistant", content: "ok" },
        ],
      }),
    });
    const bridge = await createPromptBridge(client, "srv");
    const rendered = await bridge.renderPrompt("x");
    expect(rendered.messages).toHaveLength(2);
    expect(rendered.messages[0]).toEqual({ role: "user", text: "hello" });
    expect(rendered.messages[1]).toEqual({ role: "assistant", text: "ok" });
  });

  it("ignores malformed rendered prompt messages", async () => {
    const client = makeClient({
      getPrompt: vi.fn().mockResolvedValue({
        description: 123,
        messages: [
          null,
          "noise",
          { role: "bad", content: "skip" },
          { role: "user", content: { type: "text", text: 42 } },
          { role: "system", content: "keep" },
        ],
      }),
    });

    const bridge = await createPromptBridge(client, "srv");
    const rendered = await bridge.renderPrompt("x");

    expect(rendered).toEqual({
      promptName: "x",
      messages: [
        { role: "user", rawContent: { type: "text", text: 42 } },
        { role: "system", text: "keep" },
      ],
    });
  });

  it("treats non-array rendered prompt messages as empty", async () => {
    const client = makeClient({
      getPrompt: vi.fn().mockResolvedValue({
        description: "desc",
        messages: { role: "user", content: "not-array" },
      }),
    });

    const bridge = await createPromptBridge(client, "srv");

    await expect(bridge.renderPrompt("x")).resolves.toEqual({
      promptName: "x",
      description: "desc",
      messages: [],
    });
  });

  it("flattens arrays of text blocks", async () => {
    const client = makeClient({
      getPrompt: vi.fn().mockResolvedValue({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "line 1" },
              { type: "text", text: "line 2" },
            ],
          },
        ],
      }),
    });
    const bridge = await createPromptBridge(client, "srv");
    const rendered = await bridge.renderPrompt("x");
    expect(rendered.messages[0].text).toBe("line 1\nline 2");
  });

  it("preserves rawContent for non-text payloads", async () => {
    const client = makeClient({
      getPrompt: vi.fn().mockResolvedValue({
        messages: [
          {
            role: "user",
            content: { type: "image", data: "base64-blob" },
          },
        ],
      }),
    });
    const bridge = await createPromptBridge(client, "srv");
    const rendered = await bridge.renderPrompt("x");
    expect(rendered.messages[0].rawContent).toEqual({
      type: "image",
      data: "base64-blob",
    });
  });

  it("throws after disposal", async () => {
    const client = makeClient({
      getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
    });
    const bridge = await createPromptBridge(client, "srv");
    await bridge.dispose();
    await expect(bridge.renderPrompt("x")).rejects.toThrow(/disposed/);
  });
});
